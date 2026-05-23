from fastapi import APIRouter, Depends

from app import refresh as refresh_mod
from app.auth import require_admin

router = APIRouter()


@router.post("/refresh", dependencies=[Depends(require_admin)])
def trigger_refresh(season: int = refresh_mod.DEFAULT_SEASON) -> dict:
    """Kick off a background sync (injuries + gamelogs). Returns current
    status. If a sync is already running, no-ops and returns the running
    status."""
    return refresh_mod.trigger_sync(season=season)


@router.get("/refresh/status")
def refresh_status() -> dict:
    return refresh_mod.get_status()
