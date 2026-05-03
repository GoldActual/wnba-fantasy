"""One-time bootstrap: scrape BBR's WNBA season-totals page and populate
`players.bbr_slug` by normalized-name match.

Idempotent — re-running only updates rows whose slug is currently NULL or
mismatches the freshly-scraped value. Safe to run any time a new WNBA
season's totals page is available (e.g. early 2027 for 2026 totals, once
the season finishes).

For 2026 prep, point this at season=2025 (the most recent completed
year). Rookies and 2026-only signings won't match here — they'll get
slugs filled in by a follow-up name-search step (TODO) or manually.

Usage:
    python scripts/discover-bbr-slugs.py             # default season=2025
    python scripts/discover-bbr-slugs.py --season 2024
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
from app.matching import normalize_name
from app.models import Player
from app.scrapers import bbr_gamelogs
from app.scrapers.base import RateLimitedSession


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2025)
    args = parser.parse_args()

    init_db()
    sess = RateLimitedSession()

    print(f"[1/1] BBR /wnba/years/{args.season}_totals.html — discovering slugs")
    entries = bbr_gamelogs.fetch_player_index(args.season, sess)
    print(f"      fetched {len(entries)} player rows from BBR totals")

    by_norm: dict[str, str] = {}  # normalized_name -> slug
    duplicate_norms: set[str] = set()
    for e in entries:
        key = normalize_name(e.name)
        if key in by_norm and by_norm[key] != e.slug:
            duplicate_norms.add(key)
        else:
            by_norm[key] = e.slug

    if duplicate_norms:
        print(f"      WARNING: {len(duplicate_norms)} normalized-name collisions in BBR data")

    matched = unmatched = updated = unchanged = 0
    unmatched_names: list[str] = []
    with SessionLocal() as db:
        players = list(db.scalars(select(Player)).all())
        for p in players:
            slug = by_norm.get(normalize_name(p.name))
            if slug is None:
                unmatched += 1
                unmatched_names.append(p.name)
                continue
            matched += 1
            if p.bbr_slug == slug:
                unchanged += 1
            else:
                p.bbr_slug = slug
                updated += 1
        db.commit()

    print(f"      DB players: {len(players)}")
    print(f"      matched {matched} (updated {updated}, unchanged {unchanged})")
    print(f"      unmatched {unmatched} (rookies, 2026 signings, retired vets)")
    if unmatched_names:
        print(f"      first 20 unmatched: {unmatched_names[:20]}")


if __name__ == "__main__":
    main()
