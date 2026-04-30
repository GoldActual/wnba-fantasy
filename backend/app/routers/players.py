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
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Roster
from app.value import PlayerValue, compute_player_values

router = APIRouter()


def _serialize(v: PlayerValue, drafted_by: dict[int, int]) -> dict:
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
        "drafted_by_team_id": drafted_by.get(v.player_id),
        "totals": {
            "games_played": v.games_played,
            "points": v.points,
            "rebounds": v.rebounds,
            "assists": v.assists,
            "steals": v.steals,
            "blocks": v.blocks,
        },
        "z_scores": {
            "points": round(v.z_points, 3),
            "rebounds": round(v.z_rebounds, 3),
            "assists": round(v.z_assists, 3),
            "steals": round(v.z_steals, 3),
            "blocks": round(v.z_blocks, 3),
        },
        "value": round(v.value, 3),
        "raw_value": round(v.raw_value, 3),
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
) -> dict:
    values = compute_player_values(db)
    drafted_by = {r.player_id: r.team_id for r in db.scalars(select(Roster)).all()}

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
        "players": [_serialize(v, drafted_by) for v in values],
    }
