"""Draft endpoints — team setup, on-the-clock derivation, pick + undo, CSV export.

Snake-order derivation is fully derived from the count of `rosters` rows:
no separate "current pick" state is stored, so the source of truth stays in
the rosters/transactions tables and undo is just `DELETE LAST`.
"""
from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.responses import Response

from app.db import get_db
from app.models import Player, Roster, Team, Transaction
from app.value import (
    aggregate_team_totals,
    compute_pace_targets,
    compute_player_values,
    per_cat_pace_status,
)

router = APIRouter()

# Roster shape: 2G, 2F, 1C, 1UTIL — 6 picks per team.
ROSTER_SHAPE: dict[str, int] = {"G": 2, "F": 2, "C": 1, "UTIL": 1}
PICKS_PER_TEAM = sum(ROSTER_SHAPE.values())  # 6
VALID_SLOTS = set(ROSTER_SHAPE)


# ----- request / response shapes -----

class TeamSetupItem(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    draft_slot: int = Field(ge=1, le=16)
    is_my_team: bool = False


class TeamSetupRequest(BaseModel):
    teams: list[TeamSetupItem] = Field(min_length=2, max_length=16)
    force: bool = False  # required if any picks have already been made


class PickRequest(BaseModel):
    player_id: int
    # Both optional. team_id defaults to the on-the-clock team. slot is
    # auto-assigned server-side using the most-restrictive eligible open
    # slot (C → F → G → UTIL) — the user shouldn't have to think about
    # slot bookkeeping during the draft.
    team_id: int | None = None
    slot: str | None = None


# ----- helpers -----

def _active_teams(db: Session) -> list[Team]:
    return list(
        db.scalars(
            select(Team).where(Team.is_active.is_(True)).order_by(Team.draft_slot)
        ).all()
    )


def _on_the_clock(teams: list[Team], picks_made: int) -> tuple[Team | None, int, int] | None:
    """Returns (team, round, slot_index_1based) for the next pick, or None
    when the draft is complete."""
    if not teams:
        return None
    n = len(teams)
    total_picks = n * PICKS_PER_TEAM
    if picks_made >= total_picks:
        return None
    round_num = picks_made // n + 1
    idx = picks_made % n  # 0-based index within the round
    if round_num % 2 == 1:
        slot_index = idx + 1  # 1, 2, ..., n
    else:
        slot_index = n - idx  # n, n-1, ..., 1
    team = next((t for t in teams if t.draft_slot == slot_index), None)
    return (team, round_num, slot_index)


def _slot_eligible(positions: list[str], slot: str) -> bool:
    if slot == "UTIL":
        return True
    return slot in (positions or [])


def _team_slot_open(db: Session, team_id: int, slot: str) -> bool:
    used = len(
        db.scalars(
            select(Roster).where(Roster.team_id == team_id, Roster.slot == slot)
        ).all()
    )
    return used < ROSTER_SHAPE[slot]


def _slot_usage(db: Session, team_id: int) -> dict[str, int]:
    counts = {s: 0 for s in ROSTER_SHAPE}
    for r in db.scalars(select(Roster).where(Roster.team_id == team_id)).all():
        if r.slot in counts:
            counts[r.slot] += 1
    return counts


def _auto_assign_slot(positions: list[str], team_id: int, db: Session) -> str | None:
    """Pick the most-restrictive eligible open slot. Returns None if the
    team has no open slot the player can fill (which only happens if the
    team already has 6 picks — i.e. UTIL is also full)."""
    used = _slot_usage(db, team_id)
    pos_set = set(positions or [])
    for slot in ("C", "F", "G"):  # most restrictive first
        if slot in pos_set and used[slot] < ROSTER_SHAPE[slot]:
            return slot
    if used["UTIL"] < ROSTER_SHAPE["UTIL"]:
        return "UTIL"
    return None


def _serialize_roster_row(r: Roster) -> dict:
    p = r.player
    return {
        "roster_id": r.id,
        "team_id": r.team_id,
        "player_id": r.player_id,
        "slot": r.slot,
        "drafted_round": r.drafted_round,
        "drafted_overall_pick": r.drafted_overall_pick,
        "player": {
            "id": p.id,
            "name": p.name,
            "positions": p.positions,
            "wnba_team": p.wnba_team,
            "is_rookie": p.is_rookie,
            "draft_pick": p.draft_pick,
        },
    }


# ----- endpoints -----

@router.get("/teams")
def list_teams(db: Session = Depends(get_db)) -> dict:
    teams = _active_teams(db)
    return {
        "teams": [
            {
                "id": t.id,
                "name": t.name,
                "draft_slot": t.draft_slot,
                "is_my_team": t.is_my_team,
            }
            for t in teams
        ]
    }


@router.post("/teams/setup")
def setup_teams(req: TeamSetupRequest, db: Session = Depends(get_db)) -> dict:
    """Wipe-and-replace draft state. Destructive: deletes all teams,
    rosters, and draft transactions. Pass `force=true` if any picks have
    already been made (i.e. rosters table is non-empty)."""
    slots = [t.draft_slot for t in req.teams]
    if sorted(slots) != list(range(1, len(req.teams) + 1)):
        raise HTTPException(400, f"draft_slot must be a contiguous 1..N permutation; got {slots}")
    if sum(1 for t in req.teams if t.is_my_team) > 1:
        raise HTTPException(400, "at most one team can be marked is_my_team")

    pick_count = len(db.scalars(select(Roster)).all())
    if pick_count and not req.force:
        raise HTTPException(
            409,
            f"{pick_count} picks already made; pass force=true to wipe and reset",
        )

    db.execute(delete(Roster))
    db.execute(delete(Transaction).where(Transaction.transaction_type == "draft"))
    db.execute(delete(Team))
    db.flush()
    for t in req.teams:
        db.add(Team(name=t.name.strip(), draft_slot=t.draft_slot, is_my_team=t.is_my_team))
    db.commit()
    return list_teams(db)


@router.delete("/teams")
def reset_teams(db: Session = Depends(get_db)) -> dict:
    """Equivalent to setup-with-empty: blow away teams + rosters + draft
    transactions. Frontend uses this when the user hits 'Reset draft'."""
    db.execute(delete(Roster))
    db.execute(delete(Transaction).where(Transaction.transaction_type == "draft"))
    db.execute(delete(Team))
    db.commit()
    return {"status": "ok"}


@router.get("/draft/state")
def draft_state(db: Session = Depends(get_db)) -> dict:
    teams = _active_teams(db)
    rosters = list(
        db.scalars(select(Roster).order_by(Roster.drafted_overall_pick.asc())).all()
    )
    picks_made = len(rosters)
    clock = _on_the_clock(teams, picks_made)

    if not teams:
        on_clock = None
        is_complete = False
    elif clock is None:
        on_clock = None
        is_complete = True
    else:
        team, round_num, slot_index = clock
        on_clock = {
            "team_id": team.id if team else None,
            "team_name": team.name if team else None,
            "round": round_num,
            "draft_slot": slot_index,
            "overall_pick": picks_made + 1,
        }
        is_complete = False

    # Pace targets + per-team cat status. Skips computation if there are
    # no teams yet (pre-setup) — saves a chunk of work on the empty path.
    pace_targets: dict[str, float] = {}
    team_cat_status: dict[int, dict] = {}
    if teams:
        values = compute_player_values(db)
        pace_targets = compute_pace_targets(values, n_teams=len(teams))
        rosters_by_team: dict[int, set[int]] = {t.id: set() for t in teams}
        picks_count_by_team: dict[int, int] = {t.id: 0 for t in teams}
        for r in rosters:
            rosters_by_team[r.team_id].add(r.player_id)
            picks_count_by_team[r.team_id] += 1
        for t in teams:
            totals = aggregate_team_totals(values, rosters_by_team[t.id])
            status = per_cat_pace_status(totals, pace_targets, picks_count_by_team[t.id])
            team_cat_status[t.id] = {"totals": totals, "by_cat": status}

    return {
        "teams": [
            {
                "id": t.id, "name": t.name, "draft_slot": t.draft_slot,
                "is_my_team": t.is_my_team,
            }
            for t in teams
        ],
        "rosters": [_serialize_roster_row(r) for r in rosters],
        "picks_made": picks_made,
        "total_picks": len(teams) * PICKS_PER_TEAM,
        "on_the_clock": on_clock,
        "is_complete": is_complete,
        "roster_shape": ROSTER_SHAPE,
        "pace_targets": {k: round(v, 1) for k, v in pace_targets.items()},
        "team_cat_status": team_cat_status,
    }


@router.post("/draft/pick")
def make_pick(req: PickRequest, db: Session = Depends(get_db)) -> dict:
    teams = _active_teams(db)
    if not teams:
        raise HTTPException(400, "no teams configured; run /api/teams/setup first")

    picks_made = len(db.scalars(select(Roster)).all())
    clock = _on_the_clock(teams, picks_made)
    if clock is None:
        raise HTTPException(409, "draft is complete; nothing on the clock")
    on_clock_team, round_num, slot_index = clock

    # Resolve target team: explicit team_id or default to on-the-clock.
    if req.team_id is not None:
        target_team = next((t for t in teams if t.id == req.team_id), None)
        if target_team is None:
            raise HTTPException(404, f"team {req.team_id} not found")
    else:
        target_team = on_clock_team
    if target_team is None:
        raise HTTPException(500, f"on-the-clock slot {slot_index} not found in teams")

    player = db.get(Player, req.player_id)
    if player is None:
        raise HTTPException(404, f"player {req.player_id} not found")
    already = db.scalar(select(Roster).where(Roster.player_id == player.id))
    if already is not None:
        raise HTTPException(409, f"{player.name} is already on team {already.team_id}")

    # Resolve slot: explicit `slot` or auto-assigned. We still validate the
    # auto-pick because a player like Awa Fam Thiam (no positions in DB)
    # can only land in UTIL.
    slot = req.slot
    if slot is None:
        slot = _auto_assign_slot(player.positions or [], target_team.id, db)
        if slot is None:
            raise HTTPException(409, f"{target_team.name} has no open slot for {player.name}")
    else:
        if slot not in VALID_SLOTS:
            raise HTTPException(400, f"invalid slot {slot!r}; must be one of {sorted(VALID_SLOTS)}")
        if not _slot_eligible(player.positions or [], slot):
            raise HTTPException(
                400,
                f"{player.name} ({'/'.join(player.positions or []) or 'no positions'}) "
                f"is not eligible for slot {slot}",
            )
        if not _team_slot_open(db, target_team.id, slot):
            raise HTTPException(409, f"{target_team.name}'s {slot} slot is full")

    overall_pick = picks_made + 1
    roster = Roster(
        team_id=target_team.id,
        player_id=player.id,
        slot=slot,
        drafted_round=round_num,
        drafted_overall_pick=overall_pick,
    )
    db.add(roster)
    db.add(Transaction(
        transaction_type="draft",
        player_id=player.id,
        from_team_id=None,
        to_team_id=target_team.id,
        effective_date=date.today(),
        notes=f"R{round_num}.P{overall_pick} {slot}",
    ))
    db.commit()
    return draft_state(db)


@router.delete("/draft/pick/last")
def undo_last_pick(db: Session = Depends(get_db)) -> dict:
    last = db.scalar(
        select(Roster).order_by(Roster.drafted_overall_pick.desc()).limit(1)
    )
    if last is None:
        raise HTTPException(409, "no picks to undo")
    pid = last.player_id
    db.delete(last)
    # Best-effort match for the corresponding draft transaction (most recent
    # 'draft' row for this player).
    txn = db.scalar(
        select(Transaction)
        .where(
            Transaction.transaction_type == "draft",
            Transaction.player_id == pid,
        )
        .order_by(Transaction.id.desc())
        .limit(1)
    )
    if txn is not None:
        db.delete(txn)
    db.commit()
    return draft_state(db)


@router.get("/draft/csv")
def draft_csv(db: Session = Depends(get_db)) -> Response:
    rosters = db.scalars(
        select(Roster).order_by(Roster.drafted_overall_pick.asc())
    ).all()
    teams_by_id = {t.id: t for t in db.scalars(select(Team)).all()}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "overall_pick", "round", "team", "player", "slot",
        "wnba_team", "positions", "is_rookie", "school",
    ])
    for r in rosters:
        p = r.player
        team = teams_by_id.get(r.team_id)
        w.writerow([
            r.drafted_overall_pick,
            r.drafted_round,
            team.name if team else r.team_id,
            p.name,
            r.slot,
            p.wnba_team or "",
            "/".join(p.positions or []),
            "Y" if p.is_rookie else "",
            p.school or "",
        ])
    csv_text = buf.getvalue()
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="wnba_draft.csv"',
        },
    )
