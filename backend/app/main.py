from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import init_db
from app.refresh import trigger_sync
from app.routers import draft, health, players, refresh, simulator, standings, transactions


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Boot-time data refresh runs in a background thread so server startup
    # is not blocked. Views show stale data until the sync completes; the
    # status endpoint + Sync button surface progress.
    trigger_sync()
    yield


app = FastAPI(title="WNBA Fantasy Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(players.router, prefix="/api")
app.include_router(draft.router, prefix="/api")
app.include_router(standings.router, prefix="/api")
app.include_router(transactions.router, prefix="/api")
app.include_router(simulator.router, prefix="/api")
app.include_router(refresh.router, prefix="/api")
