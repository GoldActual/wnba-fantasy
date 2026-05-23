"""Per-day league snapshots for the Trends chart view."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.standings import CATS
from app.trends import compute_trends

router = APIRouter()


@router.get("/trends")
def get_trends(season: int = 2026, db: Session = Depends(get_db)) -> dict:
    result = compute_trends(db, season=season)
    return {
        "season": result.season,
        "computed_at": result.computed_at.isoformat(),
        "team_names": {str(tid): name for tid, name in result.team_names.items()},
        "days": [
            {
                "date": d.snapshot_date.isoformat(),
                "teams": {
                    str(tid): {
                        "standing": round(ts.standing, 2),
                        "rank_sum": round(ts.rank_sum, 2),
                        "cats": {c: ts.cats[c] for c in CATS},
                    }
                    for tid, ts in d.teams.items()
                },
            }
            for d in result.days
        ],
    }
