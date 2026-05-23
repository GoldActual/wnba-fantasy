"""APScheduler wiring for the always-on Pi deployment.

One job: trigger a full sync at 6am Pacific every day. `trigger_sync`
spawns its own daemon thread and no-ops if a sync is already running, so
the scheduler job itself just kicks it and returns immediately — no
overlap risk, no async/sync mismatch, no need for misfire grace.

Using AsyncIOScheduler (not BackgroundScheduler) so the scheduler shares
uvicorn's event loop. The lifespan handler in main.py starts/stops it
alongside the rest of the boot sequence.

Why 6am Pacific: WNBA games typically wrap by midnight PT; 6am gives
publishers a buffer to settle box scores. Single daily sync keeps the
scraping footprint minimal on residential WiFi.
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.refresh import trigger_sync

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def start_scheduler() -> None:
    """Idempotent start — safe to call from lifespan."""
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return
    sched = AsyncIOScheduler()
    sched.add_job(
        _run_sync_job,
        CronTrigger(hour=6, minute=0, timezone="America/Los_Angeles"),
        id="daily_sync_6am_pt",
        replace_existing=True,
    )
    sched.start()
    _scheduler = sched
    logger.info("scheduler started; next daily_sync_6am_pt fire: %s",
                sched.get_job("daily_sync_6am_pt").next_run_time)


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    # wait=False — the scrape itself runs in a daemon thread with
    # incremental SQLite commits, so partial progress survives shutdown.
    # We'd rather restart fast than block on a 10-min scrape.
    _scheduler.shutdown(wait=False)
    _scheduler = None


def _run_sync_job() -> None:
    logger.info("scheduled sync firing")
    trigger_sync()
