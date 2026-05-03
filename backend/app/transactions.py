"""Transaction domain logic — ownership timelines, pickup / trade
event creation, per-team usage counting.

Schema lives in models.Transaction (one row per player-movement). Logical
league events ("pickup" = add + drop, "trade" = two-player swap) are
grouped by `event_id` (UUID4). Counting transactions against the
2-strategic + 2-injury budget = counting distinct event_ids per team.

Ownership timeline rules (the heart of backdating):
  - Sort each player's transactions by effective_date, then created_at as a
    deterministic tiebreaker.
  - Walk chronologically; build (start_date, end_date_inclusive, team_id)
    windows. Every game on a date inside a window is attributed to that
    team. The effective_date of a new owner is **inclusive** (a game on
    that date attributes to the new owner). The previous owner's window
    closes on `effective_date - 1 day`.
  - 'draft', 'add', and the to-team side of a 'trade' all open / continue a
    new-owner window.
  - 'drop', and the from-team side of a 'trade', close the previous
    owner's window.
  - 'team_dissolved' is treated as a drop for whichever team the row
    affects (Phase-2 future use).

The current Roster table is the *current ownership* projection. Every
event-creating call here updates Roster atomically alongside writing
Transaction rows, so the draft UI / scoreboard "current" path stays fast
and consistent.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Player, Roster, Team, Transaction

EVENT_TYPES = ("add", "drop", "trade")  # rows whose event_id counts toward the 4-per-season cap
CATEGORIES = ("strategic", "injury")
TRANSACTIONS_PER_TEAM = 4
STRATEGIC_PER_TEAM = 2
INJURY_PER_TEAM = 2


@dataclass(frozen=True)
class OwnershipWindow:
    start: date            # inclusive
    end: date | None       # inclusive; None means "current owner, open-ended"
    team_id: int


def _tx_sort_key(t: Transaction) -> tuple[date, int]:
    return (t.effective_date, t.id)


def ownership_windows_for_player(
    txs: list[Transaction],
) -> list[OwnershipWindow]:
    """Build the [(start, end, team)] timeline for a single player's
    transaction history. `txs` may include any subset of types — only
    'draft', 'add', 'drop', 'trade', 'team_dissolved' are interpreted."""
    windows: list[OwnershipWindow] = []
    current_team: int | None = None
    current_start: date | None = None

    def close_window(close_date: date) -> None:
        nonlocal current_team, current_start
        if current_team is not None and current_start is not None and close_date >= current_start:
            windows.append(OwnershipWindow(current_start, close_date, current_team))
        current_team = None
        current_start = None

    for t in sorted(txs, key=_tx_sort_key):
        ttype = t.transaction_type
        if ttype in ("draft", "add"):
            if current_team is not None and current_start is not None:
                # Out-of-order data — close previous window the day before.
                close_window(t.effective_date - timedelta(days=1))
            current_team = t.to_team_id
            current_start = t.effective_date
        elif ttype == "drop" or ttype == "team_dissolved":
            close_window(t.effective_date - timedelta(days=1))
        elif ttype == "trade":
            # A trade row's perspective is from from_team -> to_team for
            # this player. Close out the prior (from) window and open
            # the new one.
            close_window(t.effective_date - timedelta(days=1))
            current_team = t.to_team_id
            current_start = t.effective_date
        # Other types: ignore.

    if current_team is not None and current_start is not None:
        windows.append(OwnershipWindow(current_start, None, current_team))
    return windows


def build_ownership_timelines(
    db: Session,
) -> dict[int, list[OwnershipWindow]]:
    """player_id -> ordered ownership windows, across all transactions."""
    txs = list(db.scalars(select(Transaction)).all())
    by_player: dict[int, list[Transaction]] = defaultdict(list)
    for t in txs:
        if t.player_id is None:
            continue
        by_player[t.player_id].append(t)
    return {pid: ownership_windows_for_player(rows) for pid, rows in by_player.items()}


def owner_on_date(
    windows: list[OwnershipWindow],
    d: date,
) -> int | None:
    """Which team owned this player on date `d`? None = nobody (FA)."""
    for w in windows:
        if w.start <= d and (w.end is None or d <= w.end):
            return w.team_id
    return None


# ---- transaction usage counting ----

@dataclass(frozen=True)
class TeamUsage:
    team_id: int
    strategic: int
    injury: int
    total: int


def usage_by_team(db: Session) -> dict[int, TeamUsage]:
    """Count distinct event_ids per team, split by category.

    Each pickup or trade is one event_id; an event_id involves one team
    (pickup) or two teams (trade). Both involved teams take the hit.
    'draft' rows have null event_id and don't count."""
    txs = list(db.scalars(select(Transaction).where(Transaction.event_id.is_not(None))).all())
    teams = list(db.scalars(select(Team)).all())

    # event_id -> (category, set of team_ids involved)
    events: dict[str, tuple[str, set[int]]] = {}
    for t in txs:
        cat = t.category or "strategic"
        rec = events.get(t.event_id)
        if rec is None:
            events[t.event_id] = (cat, set())
        else:
            cat = rec[0]  # category is set once for the event
        for tid in (t.from_team_id, t.to_team_id):
            if tid is not None:
                events[t.event_id][1].add(tid)

    counts: dict[int, dict[str, int]] = {tm.id: {"strategic": 0, "injury": 0} for tm in teams}
    for cat, team_ids in events.values():
        bucket = "injury" if cat == "injury" else "strategic"
        for tid in team_ids:
            if tid in counts:
                counts[tid][bucket] += 1

    return {
        tid: TeamUsage(team_id=tid, strategic=v["strategic"], injury=v["injury"],
                       total=v["strategic"] + v["injury"])
        for tid, v in counts.items()
    }


# ---- event creation ----

class TransactionError(ValueError):
    pass


def _today_or(d: date | None) -> date:
    return d if d is not None else date.today()


_SLOT_TAG = "[slot="


def _encode_slot_note(user_note: str | None, slot: str) -> str:
    """Append a slot tag to the user's note so undo can restore the slot.
    Format: '<user_note> [slot=C]'. We separate with a space; an absent
    user_note collapses to just the tag."""
    tag = f"{_SLOT_TAG}{slot}]"
    if not user_note:
        return tag
    return f"{user_note} {tag}"


def _decode_slot_note(note: str | None) -> str | None:
    """Inverse of `_encode_slot_note`. Returns the slot or None if missing."""
    if not note or _SLOT_TAG not in note:
        return None
    after = note.split(_SLOT_TAG, 1)[1]
    end = after.find("]")
    if end < 0:
        return None
    slot = after[:end]
    return slot if slot in {"G", "F", "C", "UTIL"} else None


def record_pickup(
    db: Session,
    *,
    team_id: int,
    add_player_id: int,
    drop_player_id: int,
    effective_date: date | None = None,
    category: str = "strategic",
    note: str | None = None,
) -> str:
    """Atomic add+drop. Returns the new event_id.

    Validates: dropped player currently on team's roster, added player
    currently a free agent. Effective date defaults to today; freely
    settable backwards."""
    if category not in CATEGORIES:
        raise TransactionError(f"category must be one of {CATEGORIES}, got {category!r}")
    eff = _today_or(effective_date)

    team = db.get(Team, team_id)
    if team is None:
        raise TransactionError(f"team {team_id} not found")
    add_p = db.get(Player, add_player_id)
    drop_p = db.get(Player, drop_player_id)
    if add_p is None:
        raise TransactionError(f"add_player_id {add_player_id} not found")
    if drop_p is None:
        raise TransactionError(f"drop_player_id {drop_player_id} not found")
    if add_player_id == drop_player_id:
        raise TransactionError("add and drop players must differ")

    drop_roster = db.scalar(
        select(Roster).where(Roster.team_id == team_id, Roster.player_id == drop_player_id)
    )
    if drop_roster is None:
        raise TransactionError(f"{drop_p.name} is not currently on {team.name}")
    add_roster = db.scalar(select(Roster).where(Roster.player_id == add_player_id))
    if add_roster is not None:
        raise TransactionError(
            f"{add_p.name} is currently rostered (team_id={add_roster.team_id})"
        )

    event_id = uuid.uuid4().hex
    # Drop row records the slot the dropped player held — the added player
    # inherits that slot, and undo can restore it on rollback.
    slot = drop_roster.slot
    db.add(Transaction(
        transaction_type="drop", player_id=drop_player_id,
        from_team_id=team_id, to_team_id=None,
        effective_date=eff, event_id=event_id, category=category,
        notes=_encode_slot_note(note, slot),
    ))
    db.add(Transaction(
        transaction_type="add", player_id=add_player_id,
        from_team_id=None, to_team_id=team_id,
        effective_date=eff, event_id=event_id, category=category,
        notes=_encode_slot_note(note, slot),
    ))

    # Update Roster (current-ownership projection).
    db.delete(drop_roster)
    db.flush()
    db.add(Roster(team_id=team_id, player_id=add_player_id, slot=slot,
                  drafted_round=None, drafted_overall_pick=None))
    return event_id


def record_trade(
    db: Session,
    *,
    team_a_id: int,
    team_a_player_id: int,
    team_b_id: int,
    team_b_player_id: int,
    effective_date: date | None = None,
    category: str = "strategic",
    note: str | None = None,
) -> str:
    """Atomic 1-for-1 swap between two teams. Returns event_id.

    A's player goes to B, B's player goes to A. Each team takes one
    transaction-budget hit."""
    if category not in CATEGORIES:
        raise TransactionError(f"category must be one of {CATEGORIES}, got {category!r}")
    if team_a_id == team_b_id:
        raise TransactionError("trade must involve two different teams")
    eff = _today_or(effective_date)

    team_a = db.get(Team, team_a_id)
    team_b = db.get(Team, team_b_id)
    pa = db.get(Player, team_a_player_id)
    pb = db.get(Player, team_b_player_id)
    if not all([team_a, team_b, pa, pb]):
        raise TransactionError("team or player id not found")

    ra = db.scalar(
        select(Roster).where(Roster.team_id == team_a_id, Roster.player_id == team_a_player_id)
    )
    rb = db.scalar(
        select(Roster).where(Roster.team_id == team_b_id, Roster.player_id == team_b_player_id)
    )
    if ra is None:
        raise TransactionError(f"{pa.name} is not currently on {team_a.name}")
    if rb is None:
        raise TransactionError(f"{pb.name} is not currently on {team_b.name}")

    event_id = uuid.uuid4().hex
    db.add(Transaction(
        transaction_type="trade", player_id=team_a_player_id,
        from_team_id=team_a_id, to_team_id=team_b_id,
        effective_date=eff, event_id=event_id, category=category, notes=note,
    ))
    db.add(Transaction(
        transaction_type="trade", player_id=team_b_player_id,
        from_team_id=team_b_id, to_team_id=team_a_id,
        effective_date=eff, event_id=event_id, category=category, notes=note,
    ))

    # Swap on Roster — preserve each receiving team's slot for incoming player
    # to avoid forcing a slot reassignment unless the user wants one.
    slot_a, slot_b = ra.slot, rb.slot
    db.delete(ra)
    db.delete(rb)
    db.flush()
    db.add(Roster(team_id=team_b_id, player_id=team_a_player_id, slot=slot_b))
    db.add(Roster(team_id=team_a_id, player_id=team_b_player_id, slot=slot_a))
    return event_id


def delete_event(db: Session, event_id: str) -> int:
    """Undo a logical transaction event. Reverses Roster to the prior
    state derivable from remaining transactions, and deletes all rows
    sharing this event_id. Returns count of deleted Transaction rows.

    Limitation: for a backdated event with later events that depended on
    it (e.g. dropping the just-added player in a subsequent pickup),
    this won't auto-cascade. Caller must delete in reverse chronological
    order. We surface that as a usage rule in the UI."""
    rows = list(
        db.scalars(select(Transaction).where(Transaction.event_id == event_id)).all()
    )
    if not rows:
        raise TransactionError(f"no transactions found with event_id={event_id}")

    # Reverse Roster: undo each row's net effect.
    for t in rows:
        if t.transaction_type == "add" and t.player_id is not None and t.to_team_id is not None:
            r = db.scalar(
                select(Roster).where(Roster.team_id == t.to_team_id, Roster.player_id == t.player_id)
            )
            if r is not None:
                db.delete(r)
        elif t.transaction_type == "drop" and t.player_id is not None and t.from_team_id is not None:
            # Re-add to original team in the slot we recorded at pickup time.
            # Falls back to UTIL if the slot tag wasn't encoded (older events).
            existing = db.scalar(select(Roster).where(Roster.player_id == t.player_id))
            if existing is None:
                slot = _decode_slot_note(t.notes) or "UTIL"
                db.add(Roster(team_id=t.from_team_id, player_id=t.player_id, slot=slot))
        elif t.transaction_type == "trade" and t.player_id is not None:
            # Move back from to_team to from_team.
            r = db.scalar(
                select(Roster).where(Roster.team_id == t.to_team_id, Roster.player_id == t.player_id)
            )
            if r is not None:
                r.team_id = t.from_team_id
    db.flush()
    deleted = 0
    for t in rows:
        db.delete(t)
        deleted += 1
    return deleted
