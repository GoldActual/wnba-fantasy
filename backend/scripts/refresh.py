"""One-command data refresh: WNBA.com positions, ESPN IDs + injuries,
Rotowire season totals (2024 + 2025).

Idempotent. Safe to re-run; never touches the rosters or transactions
tables (per PLAN.md "never destructive on data refresh" rule).

Usage:
    python scripts/refresh.py
"""
from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import SessionLocal, init_db
from app.matching import normalize_name
from app.models import Injury, Player, StatsSeason
from app.scrapers import espn, rotowire, wnba
from app.scrapers.base import RateLimitedSession


SEASONS = (2024, 2025)


def upsert_wnba_players(db: Session, players: list[wnba.WnbaPlayer]) -> tuple[int, int]:
    """Insert or update players keyed by wnba_id. Returns (inserted, updated)."""
    existing_by_wnba = {
        p.wnba_id: p
        for p in db.scalars(select(Player).where(Player.wnba_id.is_not(None))).all()
    }
    inserted = updated = 0
    for src in players:
        row = existing_by_wnba.get(src.wnba_id)
        if row is None:
            db.add(Player(
                wnba_id=src.wnba_id,
                name=src.name,
                positions=src.positions,
                wnba_team=src.wnba_team,
                is_rookie=False,
                stats_source="wnba_actual",
            ))
            inserted += 1
        else:
            row.name = src.name
            row.positions = src.positions
            row.wnba_team = src.wnba_team
            updated += 1
    db.flush()
    return inserted, updated


def attach_espn_ids(db: Session, espn_players: list[espn.EspnPlayer]) -> tuple[int, list[str]]:
    """Look up DB players by normalized name; populate espn_id."""
    by_norm: dict[str, Player] = {}
    duplicate_names: set[str] = set()
    for p in db.scalars(select(Player)).all():
        key = normalize_name(p.name)
        if key in by_norm:
            duplicate_names.add(key)
        else:
            by_norm[key] = p

    matched = 0
    unmatched: list[str] = []
    for ep in espn_players:
        norm = normalize_name(ep.name)
        target = by_norm.get(norm)
        if target is None:
            unmatched.append(ep.name)
            continue
        target.espn_id = ep.espn_id
        matched += 1
    db.flush()
    if duplicate_names:
        print(f"  WARNING: duplicate normalized names in DB (ambiguous): {sorted(duplicate_names)[:5]}")
    return matched, unmatched


def upsert_season_totals(
    db: Session,
    rows: list[rotowire.RotowireSeasonTotals],
    season: int,
) -> tuple[int, int, list[str], list[tuple[str, int]]]:
    """Upsert one (player, season, 'wnba_actual') stats row per player.

    Rotowire emits one row per (player, team) — so a player traded
    mid-season has two rows that must be summed to get the season total.
    We aggregate by target player_id before writing.

    Returns (inserted, updated, unmatched_names, multi_team_players).
    """
    by_norm: dict[str, Player] = {
        normalize_name(p.name): p
        for p in db.scalars(select(Player)).all()
    }
    existing_stats = {
        (s.player_id, s.season, s.source): s
        for s in db.scalars(
            select(StatsSeason).where(StatsSeason.season == season, StatsSeason.source == "wnba_actual")
        ).all()
    }

    aggregated: dict[int, dict] = {}
    row_count: dict[int, int] = {}
    player_names: dict[int, str] = {}
    unmatched: list[str] = []

    for r in rows:
        target = by_norm.get(normalize_name(r.name))
        if target is None:
            unmatched.append(r.name)
            continue
        agg = aggregated.setdefault(target.id, {
            "games_played": 0, "minutes": 0.0,
            "points": 0, "rebounds": 0, "assists": 0,
            "steals": 0, "blocks": 0,
        })
        agg["games_played"] += r.games_played
        agg["minutes"] += r.minutes
        agg["points"] += r.points
        agg["rebounds"] += r.rebounds
        agg["assists"] += r.assists
        agg["steals"] += r.steals
        agg["blocks"] += r.blocks
        row_count[target.id] = row_count.get(target.id, 0) + 1
        player_names[target.id] = target.name

    inserted = updated = 0
    for player_id, agg in aggregated.items():
        key = (player_id, season, "wnba_actual")
        existing = existing_stats.get(key)
        if existing is None:
            db.add(StatsSeason(player_id=player_id, season=season, source="wnba_actual", **agg))
            inserted += 1
        else:
            for k, v in agg.items():
                setattr(existing, k, v)
            updated += 1
    db.flush()

    multi_team = sorted(
        [(player_names[pid], n) for pid, n in row_count.items() if n > 1],
        key=lambda x: -x[1],
    )
    return inserted, updated, unmatched, multi_team


def upsert_injuries(db: Session, injuries: list[espn.EspnInjury]) -> tuple[int, int, int]:
    """Upsert injury rows by espn_player_id. Link to player via espn_id.
    Returns (inserted, updated, unlinked_count)."""
    existing_by_espn = {
        i.espn_player_id: i
        for i in db.scalars(select(Injury)).all()
    }
    players_by_espn = {
        p.espn_id: p
        for p in db.scalars(select(Player).where(Player.espn_id.is_not(None))).all()
    }

    seen_espn_ids: set[str] = set()
    inserted = updated = unlinked = 0
    for inj in injuries:
        seen_espn_ids.add(inj.espn_id)
        target = players_by_espn.get(inj.espn_id)
        player_id = target.id if target else None
        if target is None:
            unlinked += 1
        existing = existing_by_espn.get(inj.espn_id)
        if existing is None:
            db.add(Injury(
                player_id=player_id,
                espn_player_id=inj.espn_id,
                status=inj.status,
                return_date=inj.return_date,
                description=inj.description,
            ))
            inserted += 1
        else:
            existing.player_id = player_id
            existing.status = inj.status
            existing.return_date = inj.return_date
            existing.description = inj.description
            updated += 1

    # Drop stale injuries — if a player no longer appears on the ESPN report,
    # they're considered healthy now. (We never delete players or stats; only
    # injury snapshot rows.)
    deleted = 0
    for espn_id, row in list(existing_by_espn.items()):
        if espn_id not in seen_espn_ids:
            db.delete(row)
            deleted += 1
    db.flush()
    if deleted:
        print(f"  removed {deleted} stale injury rows (players no longer on ESPN report)")
    return inserted, updated, unlinked


def print_sample_report(db: Session) -> None:
    print()
    print("=" * 60)
    print(" SAMPLE REPORT")
    print("=" * 60)

    total = db.scalar(select(func.count()).select_from(Player)) or 0
    with_espn = db.scalar(
        select(func.count()).select_from(Player).where(Player.espn_id.is_not(None))
    ) or 0
    print(f"\nPlayers: {total} (ESPN ID coverage: {with_espn}/{total} = {100*with_espn/max(total,1):.0f}%)")

    pos_counter: Counter[tuple[str, ...]] = Counter()
    for p in db.scalars(select(Player)).all():
        pos_counter[tuple(p.positions)] += 1
    print("Positions distribution:")
    for pos_tuple, n in sorted(pos_counter.items(), key=lambda x: -x[1]):
        label = "/".join(pos_tuple) if pos_tuple else "(none)"
        print(f"  {label:<8} {n}")

    duals = db.scalars(select(Player)).all()
    duals = [p for p in duals if len(p.positions) >= 2]
    print(f"\nDual-position players: {len(duals)}")
    for p in duals[:8]:
        print(f"  {p.name:<28} {'/'.join(p.positions):<6} {p.wnba_team or '-'}")

    for season in SEASONS:
        n = db.scalar(
            select(func.count()).select_from(StatsSeason)
            .where(StatsSeason.season == season, StatsSeason.source == "wnba_actual")
        ) or 0
        print(f"\nTop 10 scorers, {season}:")
        rows = db.execute(
            select(Player.name, Player.wnba_team, StatsSeason.games_played,
                   StatsSeason.points, StatsSeason.rebounds, StatsSeason.assists,
                   StatsSeason.steals, StatsSeason.blocks)
            .join(StatsSeason, StatsSeason.player_id == Player.id)
            .where(StatsSeason.season == season, StatsSeason.source == "wnba_actual")
            .order_by(StatsSeason.points.desc())
            .limit(10)
        ).all()
        print(f"  ({n} players have {season} totals)")
        print(f"  {'Name':<24} {'Team':<5} {'G':>3} {'PTS':>5} {'REB':>5} {'AST':>4} {'STL':>4} {'BLK':>4}")
        for r in rows:
            print(f"  {r.name:<24} {r.wnba_team or '-':<5} {r.games_played:>3} "
                  f"{r.points:>5} {r.rebounds:>5} {r.assists:>4} {r.steals:>4} {r.blocks:>4}")

    inj_count = db.scalar(select(func.count()).select_from(Injury)) or 0
    inj_linked = db.scalar(
        select(func.count()).select_from(Injury).where(Injury.player_id.is_not(None))
    ) or 0
    print(f"\nInjuries: {inj_count} ({inj_linked} linked to a player record)")
    sample_injuries = db.scalars(select(Injury).limit(8)).all()
    for inj in sample_injuries:
        player_name = inj.player.name if inj.player else "(unlinked)"
        rd = inj.return_date.isoformat() if inj.return_date else "-"
        print(f"  {player_name:<26} {inj.status:<13} return={rd}")


def main() -> None:
    init_db()
    sess = RateLimitedSession()

    with SessionLocal() as db:
        print("[1/4] WNBA.com /players — positions + WNBA IDs")
        wnba_players = wnba.fetch_current_players(sess)
        ins, upd = upsert_wnba_players(db, wnba_players)
        print(f"      fetched {len(wnba_players)} players (inserted {ins}, updated {upd})")
        db.commit()

        print("[2/4] ESPN team rosters — ESPN IDs")
        espn_players = espn.fetch_player_index(sess)
        matched, unmatched = attach_espn_ids(db, espn_players)
        print(f"      fetched {len(espn_players)} ESPN players (matched {matched}, unmatched {len(unmatched)})")
        if unmatched:
            print(f"      first 8 unmatched ESPN names: {unmatched[:8]}")
        db.commit()

        print("[3/4] Rotowire season totals")
        for season in SEASONS:
            rows = rotowire.fetch_season_totals(season, sess)
            ins, upd, unmatched, multi_team = upsert_season_totals(db, rows, season)
            print(f"      {season}: fetched {len(rows)} (inserted {ins}, updated {upd}, unmatched {len(unmatched)})")
            if multi_team:
                print(f"      {len(multi_team)} traded players (rows summed):")
                for name, n in multi_team[:5]:
                    print(f"        {name} ({n} teams)")
            if unmatched:
                print(f"      first 8 unmatched {season} names: {unmatched[:8]}")
            db.commit()

        print("[4/4] ESPN injuries")
        injuries = espn.fetch_injuries(sess)
        ins, upd, unlinked = upsert_injuries(db, injuries)
        print(f"      fetched {len(injuries)} injuries (inserted {ins}, updated {upd}, unlinked {unlinked})")
        db.commit()

        print_sample_report(db)


if __name__ == "__main__":
    main()
