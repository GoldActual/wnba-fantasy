"""Daily snapshots of league standings over the season.

Replays game_stats day by day, attributing each game via the ownership
timeline (so backdated trades are honored), and emits a per-team snapshot
{ standing, rank_sum, cats: {cat: cumulative_total} } for every date with
at least one game played. Designed for a line-chart "how is everyone
trending" view.

Cost: O(games + dates × teams × cats). With ~10 games/day across 8 teams
and 5 months of season, this is small. Compute on request; no caching.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import GameStats, Team
from app.standings import CATS, CURRENT_SEASON, _rank_with_ties
from app.transactions import build_ownership_timelines, owner_on_date


@dataclass(frozen=True)
class TeamDaySnapshot:
    team_id: int
    standing: float       # 1..N tie-aware overall place (lower = better)
    rank_sum: float       # sum of 5 cat ranks (lower = better)
    cats: dict[str, int]  # cumulative cat totals as of this date


@dataclass(frozen=True)
class DaySnapshot:
    snapshot_date: date
    teams: dict[int, TeamDaySnapshot]   # team_id -> snapshot


@dataclass(frozen=True)
class TrendsResult:
    season: int
    team_names: dict[int, str]
    days: list[DaySnapshot]   # ordered by snapshot_date ascending
    computed_at: datetime


def compute_trends(
    db: Session,
    season: int = CURRENT_SEASON,
) -> TrendsResult:
    teams = list(
        db.scalars(select(Team).where(Team.is_active.is_(True)).order_by(Team.draft_slot)).all()
    )
    if not teams:
        return TrendsResult(
            season=season, team_names={}, days=[],
            computed_at=datetime.now(timezone.utc),
        )

    team_names = {t.id: t.name for t in teams}
    team_ids = list(team_names.keys())

    timelines = build_ownership_timelines(db)

    # Group games by date, then within each day group by player.
    games = list(db.scalars(select(GameStats).where(GameStats.season == season)).all())
    games.sort(key=lambda g: g.game_date)
    by_date: dict[date, list[GameStats]] = {}
    for g in games:
        by_date.setdefault(g.game_date, []).append(g)

    # Cumulative state across days.
    totals: dict[int, dict[str, int]] = {tid: {c: 0 for c in CATS} for tid in team_ids}
    days: list[DaySnapshot] = []

    for d in sorted(by_date.keys()):
        # Apply this day's games to the owning team's running totals.
        for g in by_date[d]:
            windows = timelines.get(g.player_id, [])
            if not windows:
                continue
            owner = owner_on_date(windows, g.game_date)
            if owner is None or owner not in totals:
                continue
            for c in CATS:
                totals[owner][c] += getattr(g, c)

        # Snapshot: per-cat ranks across teams, then rank-sum, then overall standing.
        cat_ranks: dict[str, dict[int, float]] = {}
        for c in CATS:
            cat_ranks[c] = _rank_with_ties(
                {tid: float(totals[tid][c]) for tid in team_ids}
            )
        rank_sums = {
            tid: sum(cat_ranks[c][tid] for c in CATS) for tid in team_ids
        }
        # _rank_with_ties expects "higher = better" — feed -rank_sum so lower
        # rank_sum yields better (lower) standing.
        standings = _rank_with_ties({tid: -rs for tid, rs in rank_sums.items()})

        day_snap = DaySnapshot(
            snapshot_date=d,
            teams={
                tid: TeamDaySnapshot(
                    team_id=tid,
                    standing=standings[tid],
                    rank_sum=rank_sums[tid],
                    cats={c: totals[tid][c] for c in CATS},
                )
                for tid in team_ids
            },
        )
        days.append(day_snap)

    return TrendsResult(
        season=season,
        team_names=team_names,
        days=days,
        computed_at=datetime.now(timezone.utc),
    )
