"""One-command data refresh: WNBA.com positions, ESPN IDs + injuries,
Rotowire season totals (2024 + 2025).

Idempotent. Safe to re-run; never touches the rosters or transactions
tables (per PLAN.md "never destructive on data refresh" rule).

Usage:
    python scripts/refresh.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal, init_db
from app.matching import normalize_name
from app.models import Injury, Player, StatsSeason
from app.reports import DEFAULT_SEASONS as SEASONS, print_sample_report
from app.rookies import ingest_draft
from app.scrapers import espn, rotowire, wnba
from app.scrapers.base import RateLimitedSession

ROOKIE_SEASON = 2026


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

        print("[4/5] ESPN injuries")
        injuries = espn.fetch_injuries(sess)
        ins, upd, unlinked = upsert_injuries(db, injuries)
        print(f"      fetched {len(injuries)} injuries (inserted {ins}, updated {upd}, unlinked {unlinked})")
        db.commit()

        print(f"[5/5] Rookies — WNBA.com /draft/{ROOKIE_SEASON}/board + sports-reference NCAA")
        rk = ingest_draft(db, sess, season=ROOKIE_SEASON, verbose=True)
        print(
            f"      {rk.picks_total} picks: {rk.matched_ncaa} via NCAA per-40, "
            f"{rk.fallback_career} via career PG fallback, {rk.fallback_zero} zero "
            f"(applied {rk.overrides_applied} overrides)"
        )
        db.commit()

        print_sample_report(db)


if __name__ == "__main__":
    main()
