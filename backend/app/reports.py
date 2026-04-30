"""Pretty-printed CLI sample reports against the current DB.

Used both by `scripts/refresh.py` (after a scrape) and by
`scripts/report.py` (to re-display without re-scraping).
"""
from __future__ import annotations

from collections import Counter

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Injury, Player, StatsSeason

DEFAULT_SEASONS = (2024, 2025)


def print_sample_report(db: Session, seasons: tuple[int, ...] = DEFAULT_SEASONS) -> None:
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

    duals = [p for p in db.scalars(select(Player)).all() if len(p.positions) >= 2]
    print(f"\nDual-position players: {len(duals)}")
    for p in duals[:8]:
        print(f"  {p.name:<28} {'/'.join(p.positions):<6} {p.wnba_team or '-'}")

    for season in seasons:
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
