"""In-app data sync: ESPN injuries + BBR per-game logs for the current season.

Shared module called by both `scripts/refresh-gamelogs.py` (CLI) and the
`POST /api/refresh` endpoint. Status is a module-level singleton guarded
by a lock so concurrent triggers no-op cleanly.

What's intentionally NOT here:
- WNBA.com /players, ESPN team rosters, Rotowire historical totals,
  rookie NCAA projections. These are stable in-season and live in the
  full `scripts/refresh.py` pipeline. Run that separately when needed
  (e.g. after a mid-season signing the league cares about).
"""
from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.db import SessionLocal
from app.models import GameStats, Player
from app.scrapers import bbr_gamelogs, espn
from app.scrapers.base import RateLimitedSession

DEFAULT_SEASON = 2026
_STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "last_sync.json"


@dataclass
class SyncStatus:
    running: bool = False
    started_at: str | None = None  # ISO 8601 UTC
    progress: str | None = None    # human-readable line for the UI
    last_completed_at: str | None = None
    last_summary: dict[str, Any] = field(default_factory=dict)
    last_error: str | None = None
    season: int = DEFAULT_SEASON


# Module singleton + lock. Mutating fields must be done with the lock held.
_status = SyncStatus()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def _load_persisted() -> None:
    """Restore last_completed_at across server restarts."""
    if not _STATE_FILE.exists():
        return
    try:
        data = json.loads(_STATE_FILE.read_text("utf-8"))
        with _lock:
            _status.last_completed_at = data.get("last_completed_at")
            _status.last_summary = data.get("last_summary") or {}
            _status.last_error = data.get("last_error")
    except Exception:  # noqa: BLE001
        # Corrupt or unreadable — ignore; we'll overwrite on next success.
        pass


def _persist() -> None:
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(
            json.dumps(
                {
                    "last_completed_at": _status.last_completed_at,
                    "last_summary": _status.last_summary,
                    "last_error": _status.last_error,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        pass


def get_status() -> dict[str, Any]:
    with _lock:
        return asdict(_status)


def _refresh_injuries(sess: RateLimitedSession) -> dict[str, int]:
    """ESPN injuries upsert. Mirrors scripts/refresh.py step 4."""
    # Local import to avoid pulling heavy modules at app boot.
    from app.models import Injury

    injuries = espn.fetch_injuries(sess)
    with SessionLocal() as db:
        existing_by_espn = {i.espn_player_id: i for i in db.scalars(select(Injury)).all()}
        players_by_espn = {
            p.espn_id: p
            for p in db.scalars(select(Player).where(Player.espn_id.is_not(None))).all()
        }
        seen: set[str] = set()
        inserted = updated = unlinked = 0
        for inj in injuries:
            seen.add(inj.espn_id)
            target = players_by_espn.get(inj.espn_id)
            if target is None:
                unlinked += 1
            existing = existing_by_espn.get(inj.espn_id)
            if existing is None:
                db.add(Injury(
                    player_id=target.id if target else None,
                    espn_player_id=inj.espn_id,
                    status=inj.status,
                    return_date=inj.return_date,
                    description=inj.description,
                ))
                inserted += 1
            else:
                existing.player_id = target.id if target else None
                existing.status = inj.status
                existing.return_date = inj.return_date
                existing.description = inj.description
                updated += 1
        deleted = 0
        for espn_id, row in list(existing_by_espn.items()):
            if espn_id not in seen:
                db.delete(row)
                deleted += 1
        db.commit()
    return {"fetched": len(injuries), "inserted": inserted, "updated": updated,
            "unlinked": unlinked, "deleted_stale": deleted}


def _refresh_gamelogs(sess: RateLimitedSession, season: int) -> dict[str, int]:
    """BBR per-player gamelog upsert for the given season."""
    with SessionLocal() as db:
        targets = list(db.scalars(
            select(Player).where(Player.bbr_slug.is_not(None)).order_by(Player.name)
        ).all())
        total = len(targets)
        ins = upd = scraped = empty = errors = 0
        for i, p in enumerate(targets, 1):
            with _lock:
                _status.progress = f"Gamelogs {i}/{total}: {p.name}"
            try:
                games = bbr_gamelogs.fetch_player_gamelog(p.bbr_slug, season, sess)
            except Exception:  # noqa: BLE001
                errors += 1
                continue
            if not games:
                empty += 1
            else:
                scraped += len(games)
            ins_i, upd_i = _upsert_player_gamelog(db, p.id, season, games)
            ins += ins_i
            upd += upd_i
            if i % 25 == 0:
                db.commit()
        db.commit()
    return {"players": total, "games_scraped": scraped, "inserted": ins,
            "updated": upd, "empty_players": empty, "errors": errors}


def _upsert_player_gamelog(db, player_id: int, season: int, games) -> tuple[int, int]:
    """Same logic as scripts/refresh-gamelogs.py's upsert helper."""
    existing = {
        g.game_date: g
        for g in db.scalars(
            select(GameStats).where(
                GameStats.player_id == player_id,
                GameStats.season == season,
            )
        ).all()
    }
    inserted = updated = 0
    for src in games:
        row = existing.get(src.game_date)
        if row is None:
            db.add(GameStats(
                player_id=player_id,
                game_date=src.game_date,
                season=season,
                team=src.team,
                opponent=src.opponent,
                is_home=src.is_home,
                started=src.started,
                minutes=src.minutes,
                points=src.points,
                rebounds=src.rebounds,
                assists=src.assists,
                steals=src.steals,
                blocks=src.blocks,
                source="bbr",
            ))
            inserted += 1
        else:
            row.team = src.team
            row.opponent = src.opponent
            row.is_home = src.is_home
            row.started = src.started
            row.minutes = src.minutes
            row.points = src.points
            row.rebounds = src.rebounds
            row.assists = src.assists
            row.steals = src.steals
            row.blocks = src.blocks
            updated += 1
    return inserted, updated


def _run_sync(season: int) -> None:
    """Worker body. Acquire lock only for status mutations, not for the
    long-running scrape itself (so /api/refresh/status stays responsive)."""
    sess = RateLimitedSession()
    summary: dict[str, Any] = {"season": season}
    try:
        with _lock:
            _status.progress = "Fetching injuries"
        summary["injuries"] = _refresh_injuries(sess)

        with _lock:
            _status.progress = "Fetching gamelogs"
        summary["gamelogs"] = _refresh_gamelogs(sess, season)

        completed = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with _lock:
            _status.last_completed_at = completed
            _status.last_summary = summary
            _status.last_error = None
            _status.progress = None
        _persist()
    except Exception as exc:  # noqa: BLE001
        with _lock:
            _status.last_error = f"{type(exc).__name__}: {exc}"
            _status.progress = None
        _persist()
    finally:
        with _lock:
            _status.running = False


def trigger_sync(season: int = DEFAULT_SEASON) -> dict[str, Any]:
    """Start a sync in a background thread if one isn't already running.

    Returns the current status dict. Safe to call repeatedly — concurrent
    invocations no-op and return the in-progress status."""
    global _worker
    with _lock:
        if _status.running:
            return asdict(_status)
        _status.running = True
        _status.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _status.season = season
        _status.last_error = None
        _status.progress = "Starting"
    _worker = threading.Thread(target=_run_sync, args=(season,), daemon=True)
    _worker.start()
    return get_status()


# Restore persisted state at import time so /api/refresh/status returns
# "last updated X" even on the first request after a server restart.
_load_persisted()
