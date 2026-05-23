"""POST /api/simulator/pickup — drop+add transaction simulator (CP11)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.simulator import SimResult, SimulatorError, simulate_pickup
from app.standings import CATS

router = APIRouter()


class SimRequest(BaseModel):
    team_id: int
    drop_player_id: int
    add_player_id: int


def _serialize_team(t) -> dict:
    return {
        "team_id": t.team_id,
        "team_name": t.team_name,
        "is_my_team": t.is_my_team,
        "draft_slot": t.draft_slot,
        "rank_sum": round(t.rank_sum, 2),
        "standing": round(t.standing, 2),
        "team_games": t.team_games,
        "cats": {
            c: {
                "total": t.cats[c].total,
                "rank": round(t.cats[c].rank, 2),
                "projected": t.cats[c].projected,
            }
            for c in CATS
        },
    }


def _serialize(r: SimResult) -> dict:
    return {
        "season": r.season,
        "full_season_games": r.full_season_games,
        "league_games_to_date": r.league_games_to_date,
        "picking_team_id": r.picking_team_id,
        "drop_player_id": r.drop_player_id,
        "drop_player_name": r.drop_player_name,
        "add_player_id": r.add_player_id,
        "add_player_name": r.add_player_name,
        "before": {"teams": [_serialize_team(t) for t in r.before.teams]},
        "after": {"teams": [_serialize_team(t) for t in r.after.teams]},
    }


@router.post("/simulator/pickup", dependencies=[Depends(require_admin)])
def post_simulate_pickup(req: SimRequest, db: Session = Depends(get_db)) -> dict:
    try:
        result = simulate_pickup(
            db,
            team_id=req.team_id,
            drop_player_id=req.drop_player_id,
            add_player_id=req.add_player_id,
        )
    except SimulatorError as e:
        raise HTTPException(400, str(e)) from e
    return _serialize(result)
