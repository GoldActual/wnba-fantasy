"""GET /api/players — value-ranked player list for the Best Available view.

Optional query params:
  - search: substring (case-insensitive) on player name
  - position: 'G' | 'F' | 'C' — show only players whose positions include it
  - hide_rookies: bool — exclude is_rookie=True
  - rookies_only: bool — include only is_rookie=True
  - limit: int — cap result count (default unbounded)

Response is a flat list, already sorted by `value` desc.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import GameStats, Roster, Team
from app.strategy import analyze_team
from app.value import (
    CATS,
    CURRENT_SEASON,
    PICKS_PER_TEAM,
    PlayerValue,
    aggregate_team_totals,
    compute_hot_player_ids,
    compute_marginal_value,
    compute_pace_targets,
    compute_player_values,
    compute_weighted_value,
)

router = APIRouter()


_EMPTY_SEASON_TOTALS = {
    "games_played": 0, "points": 0, "rebounds": 0,
    "assists": 0, "steals": 0, "blocks": 0,
}


def _current_season_totals(db: Session) -> dict[int, dict[str, int]]:
    """Sum 2026 game_stats per player so the API can return live-season
    totals alongside the value-basis totals (which may still be 2025 for
    players below the 10-GP cutover). Players with 0 games omitted; the
    serializer fills them with zeros."""
    rows = db.execute(
        select(
            GameStats.player_id,
            func.count(GameStats.id).label("gp"),
            func.coalesce(func.sum(GameStats.points), 0).label("pts"),
            func.coalesce(func.sum(GameStats.rebounds), 0).label("reb"),
            func.coalesce(func.sum(GameStats.assists), 0).label("ast"),
            func.coalesce(func.sum(GameStats.steals), 0).label("stl"),
            func.coalesce(func.sum(GameStats.blocks), 0).label("blk"),
        )
        .where(GameStats.season == CURRENT_SEASON)
        .group_by(GameStats.player_id)
    ).all()
    return {
        r.player_id: {
            "games_played": int(r.gp),
            "points": int(r.pts),
            "rebounds": int(r.reb),
            "assists": int(r.ast),
            "steals": int(r.stl),
            "blocks": int(r.blk),
        }
        for r in rows
    }


def _serialize(
    v: PlayerValue,
    drafted_by: dict[int, int],
    season_totals_by_pid: dict[int, dict[str, int]],
    hot_pids: set[int],
    marginal_by_pid: dict[int, float] | None = None,
    weighted_by_pid: dict[int, float] | None = None,
) -> dict:
    return {
        "player_id": v.player_id,
        "name": v.name,
        "positions": list(v.positions),
        "wnba_team": v.wnba_team,
        "is_rookie": v.is_rookie,
        "draft_pick": v.draft_pick,
        "school": v.school,
        "projected_mpg": v.projected_mpg,
        "override_note": v.override_note,
        "stats_source": v.stats_source,
        "injury_status": v.injury_status,
        "injury_description": v.injury_description,
        "injury_return_date": v.injury_return_date,
        "drafted_by_team_id": drafted_by.get(v.player_id),
        "totals": {
            "games_played": v.games_played,
            "points": v.points,
            "rebounds": v.rebounds,
            "assists": v.assists,
            "steals": v.steals,
            "blocks": v.blocks,
        },
        "season_totals": season_totals_by_pid.get(v.player_id, _EMPTY_SEASON_TOTALS),
        "is_hot": v.player_id in hot_pids,
        "z_scores": {
            "points": round(v.z_points, 3),
            "rebounds": round(v.z_rebounds, 3),
            "assists": round(v.z_assists, 3),
            "steals": round(v.z_steals, 3),
            "blocks": round(v.z_blocks, 3),
        },
        "value": round(v.value, 3),
        "raw_value": round(v.raw_value, 3),
        "marginal_value": (
            round(marginal_by_pid[v.player_id], 3)
            if marginal_by_pid is not None and v.player_id in marginal_by_pid
            else None
        ),
        "strategy_weighted_value": (
            round(weighted_by_pid[v.player_id], 3)
            if weighted_by_pid is not None and v.player_id in weighted_by_pid
            else None
        ),
        "factors": {
            "availability": round(v.availability_factor, 3),
            "position": round(v.position_factor, 3),
            "injury": round(v.injury_factor, 3),
            "rookie": round(v.rookie_factor, 3),
        },
    }


@router.get("/players")
def list_players(
    db: Session = Depends(get_db),
    search: str | None = Query(default=None),
    position: Literal["G", "F", "C"] | None = Query(default=None),
    hide_rookies: bool = Query(default=False),
    rookies_only: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=1000),
    for_team_id: int | None = Query(default=None),
    strategic_team_id: int | None = Query(default=None),
) -> dict:
    values = compute_player_values(db)
    drafted_by = {r.player_id: r.team_id for r in db.scalars(select(Roster)).all()}
    season_totals_by_pid = _current_season_totals(db)
    hot_pids = compute_hot_player_ids(db)

    marginal_by_pid: dict[int, float] | None = None
    if for_team_id is not None:
        n_teams = len(db.scalars(select(Team).where(Team.is_active.is_(True))).all())
        if n_teams > 0:
            pace = compute_pace_targets(values, n_teams=n_teams)
            team_pids = {
                r.player_id
                for r in db.scalars(select(Roster).where(Roster.team_id == for_team_id)).all()
            }
            team_totals = aggregate_team_totals(values, team_pids)
            picks_made_by_team = len(team_pids)
            marginal_by_pid = {
                v.player_id: compute_marginal_value(
                    v, team_totals, pace, picks_made_by_team
                )
                for v in values
            }
            # Re-sort the list by marginal value when team-aware ranking is requested.
            values.sort(key=lambda v: marginal_by_pid[v.player_id], reverse=True)

    # CP14 — strategy-weighted value. Apply per-cat weights from the strategy
    # classifier (Lock=×0.4, Contend=×1.5, Punt=×0.0) so the FA list emphasizes
    # the cats this team actually needs to push.
    weighted_by_pid: dict[int, float] | None = None
    strategy_weights: dict[str, float] | None = None
    if strategic_team_id is not None:
        try:
            ts = analyze_team(db, team_id=strategic_team_id)
            strategy_weights = {c.cat: c.weight for c in ts.cats}
            weighted_by_pid = {
                v.player_id: compute_weighted_value(v, strategy_weights)
                for v in values
            }
            values.sort(key=lambda v: weighted_by_pid[v.player_id], reverse=True)
        except ValueError:
            # Bad team_id — silently fall back to flat sort. The strategy
            # endpoint already 400s on this case; we don't want to break the
            # players list over it.
            weighted_by_pid = None
            strategy_weights = None

    if search:
        q = search.lower().strip()
        values = [v for v in values if q in v.name.lower()]
    if position:
        values = [v for v in values if position in v.positions]
    if hide_rookies and rookies_only:
        # mutually exclusive — rookies_only wins (more restrictive intent)
        values = [v for v in values if v.is_rookie]
    elif hide_rookies:
        values = [v for v in values if not v.is_rookie]
    elif rookies_only:
        values = [v for v in values if v.is_rookie]
    if limit:
        values = values[:limit]

    return {
        "count": len(values),
        "for_team_id": for_team_id,
        "strategic_team_id": strategic_team_id,
        "strategy_weights": strategy_weights,
        "players": [
            _serialize(v, drafted_by, season_totals_by_pid, hot_pids, marginal_by_pid, weighted_by_pid)
            for v in values
        ],
    }
