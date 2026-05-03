"""Daily ingest: BBR per-game logs for the current WNBA season.

For every Player with a `bbr_slug`, fetch their gamelog for the target
season and upsert into `game_stats` keyed on (player_id, game_date).
Idempotent — re-running only adds new games and updates anything that
changed (typo corrections on BBR's side; stat revisions).

Pre-season (no games yet) returns 0 games for everyone — the scoreboard
view stays at all-zeros, by design.

Usage:
    python scripts/refresh-gamelogs.py                    # default 2026, all players with slugs
    python scripts/refresh-gamelogs.py --season 2025      # historical re-run for verification
    python scripts/refresh-gamelogs.py --slug wilsoa01w   # single-player verification
    python scripts/refresh-gamelogs.py --limit 10         # first N players (smoke test)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import GameStats, Player
from app.scrapers import bbr_gamelogs
from app.scrapers.base import RateLimitedSession


def upsert_player_gamelog(
    db,
    player_id: int,
    season: int,
    games: list[bbr_gamelogs.BbrGame],
) -> tuple[int, int]:
    """Returns (inserted, updated)."""
    existing = {
        (g.game_date): g
        for g in db.scalars(
            select(GameStats).where(
                GameStats.player_id == player_id,
                GameStats.season == season,
            )
        ).all()
    }
    inserted = updated = 0
    for src in games:
        row = existing.get(src.game_date)
        if row is None:
            db.add(GameStats(
                player_id=player_id,
                game_date=src.game_date,
                season=season,
                team=src.team,
                opponent=src.opponent,
                is_home=src.is_home,
                started=src.started,
                minutes=src.minutes,
                points=src.points,
                rebounds=src.rebounds,
                assists=src.assists,
                steals=src.steals,
                blocks=src.blocks,
                source="bbr",
            ))
            inserted += 1
        else:
            row.team = src.team
            row.opponent = src.opponent
            row.is_home = src.is_home
            row.started = src.started
            row.minutes = src.minutes
            row.points = src.points
            row.rebounds = src.rebounds
            row.assists = src.assists
            row.steals = src.steals
            row.blocks = src.blocks
            updated += 1
    return inserted, updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--slug", type=str, default=None,
                        help="Single-player run by BBR slug (skips the DB filter)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Stop after N players (smoke test)")
    args = parser.parse_args()

    init_db()
    sess = RateLimitedSession()

    if args.slug:
        # Single-player verification path (doesn't require a DB row).
        print(f"[smoke] {args.slug} season={args.season}")
        games = bbr_gamelogs.fetch_player_gamelog(args.slug, args.season, sess)
        print(f"        scraped {len(games)} games")
        for g in games[:5]:
            print(f"        {g.game_date} {g.team or ''} vs {g.opponent or ''}: "
                  f"{g.points}p {g.rebounds}r {g.assists}a {g.steals}s {g.blocks}b "
                  f"({g.minutes:.1f} min)")
        return

    with SessionLocal() as db:
        targets = list(db.scalars(
            select(Player).where(Player.bbr_slug.is_not(None)).order_by(Player.name)
        ).all())
        if args.limit:
            targets = targets[:args.limit]
        print(f"[1/1] BBR gamelogs season={args.season} — {len(targets)} players "
              f"(rate-limited ~3s/req, expect ~{len(targets) * 3 / 60:.0f} min)")

        total_games = total_ins = total_upd = 0
        empty_pages = 0
        for i, p in enumerate(targets, 1):
            try:
                games = bbr_gamelogs.fetch_player_gamelog(p.bbr_slug, args.season, sess)
            except Exception as exc:  # noqa: BLE001
                print(f"      [{i}/{len(targets)}] {p.name} ({p.bbr_slug}) ERROR: {exc}")
                continue
            if not games:
                empty_pages += 1
            else:
                total_games += len(games)
            ins, upd = upsert_player_gamelog(db, p.id, args.season, games)
            total_ins += ins
            total_upd += upd
            if i % 25 == 0 or i == len(targets):
                print(f"      [{i}/{len(targets)}] cum: "
                      f"{total_games} games, {total_ins} inserted, {total_upd} updated, "
                      f"{empty_pages} empty pages")
                db.commit()
        db.commit()

        print(f"      DONE: {total_games} game rows ingested "
              f"(inserted {total_ins}, updated {total_upd}, empty {empty_pages}/{len(targets)})")


if __name__ == "__main__":
    main()
