from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Player

router = APIRouter()


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict:
    try:
        player_count = db.scalar(select(func.count()).select_from(Player)) or 0
        db_connected = True
    except Exception:
        player_count = 0
        db_connected = False
    return {
        "status": "ok",
        "db_connected": db_connected,
        "player_count": player_count,
    }
