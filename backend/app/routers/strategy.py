"""Cat-targeting strategy endpoint (CP13).

`GET /api/strategy?team_id=N&season=2026` returns per-cat classification
(Lock/Contend/Punt) + head-to-head vs every other team.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.strategy import TeamStrategy, analyze_team

router = APIRouter()


def _serialize(result: TeamStrategy) -> dict:
    return {
        "team_id": result.team_id,
        "team_name": result.team_name,
        "is_my_team": result.is_my_team,
        "team_games_played": result.team_games_played,
        "avg_team_games": result.avg_team_games,
        "low_sample": result.low_sample,
        "rank_sum": round(result.rank_sum, 2),
        "standing": round(result.standing, 2),
        "cats": [
            {
                "cat": c.cat,
                "current_total": c.current_total,
                "current_rank": round(c.current_rank, 2),
                "projected_total": c.projected_total,
                "projected_rank": round(c.projected_rank, 2),
                "gap_up": None if c.gap_up is None else round(c.gap_up, 1),
                "gap_down": None if c.gap_down is None else round(c.gap_down, 1),
                "classification": c.classification,
                "weight": c.weight,
            }
            for c in result.cats
        ],
        "head_to_head": [
            {
                "opp_team_id": h.opp_team_id,
                "opp_team_name": h.opp_team_name,
                "opp_rank_sum": round(h.opp_rank_sum, 2),
                "opp_standing": round(h.opp_standing, 2),
                "cats_winning": h.cats_winning,
                "cats_losing": h.cats_losing,
                "cats_tied": h.cats_tied,
                "cats": [
                    {
                        "cat": k.cat,
                        "my_total": k.my_total,
                        "opp_total": k.opp_total,
                        "current_gap": k.current_gap,
                        "my_projected": k.my_projected,
                        "opp_projected": k.opp_projected,
                        "projected_gap": k.projected_gap,
                        "status": k.status,
                    }
                    for k in h.cats
                ],
            }
            for h in result.head_to_head
        ],
    }


@router.get("/strategy")
def get_strategy(team_id: int, season: int = 2026, db: Session = Depends(get_db)) -> dict:
    try:
        return _serialize(analyze_team(db, team_id=team_id, season=season))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
