from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import draft, health, players, refresh, simulator, standings, strategy, transactions, trends
from app.scheduler import start_scheduler, stop_scheduler


# Built frontend lives at <repo>/frontend/dist after `npm run build`. Resolved
# relative to this file so the prod systemd unit and local dev both work.
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # No boot-time sync. The Basketball-Reference scrape takes ~9 minutes
    # and hits 187 pages, so re-running it on every code-push restart is
    # wasteful. The daily 6am PT job (scheduler.py) keeps data fresh; the
    # owner's "Sync data" button covers ad-hoc cases.
    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(title="WNBA Fantasy Tracker", lifespan=lifespan)


# IMPORTANT: include all API routers BEFORE mounting the SPA catch-all.
# Starlette matches routes in registration order; if we mount '/' first
# it shadows everything. New routers must be added above the mount.
app.include_router(health.router, prefix="/api")
app.include_router(players.router, prefix="/api")
app.include_router(draft.router, prefix="/api")
app.include_router(standings.router, prefix="/api")
app.include_router(transactions.router, prefix="/api")
app.include_router(simulator.router, prefix="/api")
app.include_router(strategy.router, prefix="/api")
app.include_router(refresh.router, prefix="/api")
app.include_router(trends.router, prefix="/api")


# Serve the built SPA from the same origin as the API. html=True makes
# Starlette serve index.html for `/` and serve `404.html` (NOT
# index.html) for unknown paths. deploy/install.sh copies index.html
# to 404.html post-build, so unknown paths fall through to the SPA shell
# and client-side routing handles them (e.g. /spectator). A typo'd API
# path like /ap/players therefore returns the HTML index rather than
# a JSON 404 — acceptable for this single-user app; the dev console
# makes the typo obvious.
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="spa")
else:
    # Don't crash boot in dev when the SPA hasn't been built; just log it.
    # API routes still work; visiting / returns 404. `npm run build` fixes.
    import logging
    logging.getLogger(__name__).warning(
        "frontend/dist not found at %s — SPA not mounted. "
        "Run `npm run build` in frontend/ for production serving.",
        FRONTEND_DIST,
    )
