"""Live scoreboard endpoint — current 2026 totals + per-cat rotis ranks
+ rank-sum standings + end-of-season pace projection.

Reads `game_stats` (CP7) under current roster ownership. Pre-season the
table is empty, so every team returns 0 in every cat and ties for 1st;
that's the by-design "everyone at 0 today" view.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.standings import CATS, compute_standings

router = APIRouter()


def _serialize(result) -> dict:
    return {
        "season": result.season,
        "league_games_to_date": result.league_games_to_date,
        "full_season_games": result.full_season_games,
        "computed_at": result.computed_at.isoformat(),
        "teams": [
            {
                "team_id": t.team_id,
                "team_name": t.team_name,
                "is_my_team": t.is_my_team,
                "draft_slot": t.draft_slot,
                "games_played": t.games_played,
                "rank_sum": round(t.rank_sum, 2),
                "standing": round(t.standing, 2),
                "cats": {
                    c: {
                        "total": t.cats[c].total,
                        "rank": round(t.cats[c].rank, 2),
                        "projected": t.cats[c].projected,
                    }
                    for c in CATS
                },
                "players": [
                    {
                        "player_id": p.player_id,
                        "name": p.name,
                        "positions": list(p.positions),
                        "wnba_team": p.wnba_team,
                        "is_rookie": p.is_rookie,
                        "games": p.games,
                        "points": p.points,
                        "rebounds": p.rebounds,
                        "assists": p.assists,
                        "steals": p.steals,
                        "blocks": p.blocks,
                        "injury_status": p.injury_status,
                        "is_current_roster": p.is_current_roster,
                    }
                    for p in t.players
                ],
            }
            for t in result.teams
        ],
    }


@router.get("/standings")
def get_standings(season: int = 2026, db: Session = Depends(get_db)) -> dict:
    return _serialize(compute_standings(db, season=season))
