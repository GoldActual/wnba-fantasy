"""Rookie ingestion: WNBA.com draft board -> sports-reference NCAA stats
-> projected WNBA season totals, written into the same `players` and
`stats_seasons` tables as veterans (with `is_rookie=True` and
`stats_source='ncaa_projection'`).

Lookups are done in this order for each pick:
  1. Search sports-reference for the player; if found, use their last
     completed college season (per-40) -> NCAA projection path.
  2. Otherwise, fall back to career-per-game stats embedded in the
     WNBA.com draft JSON.
  3. As a last resort, leave their projected stats at 0 — they'll surface
     in the override layer for manual entry.

Manual overrides live in `data/rookie_overrides.json` and are applied
after projection. See `_apply_overrides` for the shape.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import DATA_DIR
from app.matching import normalize_name
from app.models import Player, StatsSeason
from app.projections import (
    ProjectedTotals,
    load_config,
    project_from_career_pg,
    project_from_per_40,
    projected_mpg_for_pick,
)
from app.scrapers import sportsref_cbb, wnba_draft
from app.scrapers.base import RateLimitedSession

OVERRIDES_PATH = DATA_DIR / "rookie_overrides.json"

_POSITION_MAP = {
    "Guard": ["G"],
    "Forward": ["F"],
    "Center": ["C"],
    "Guard-Forward": ["G", "F"],
    "Forward-Guard": ["F", "G"],
    "Forward-Center": ["F", "C"],
    "Center-Forward": ["C", "F"],
}


@dataclass
class RookieIngestStats:
    picks_total: int
    matched_ncaa: int
    fallback_career: int
    fallback_zero: int
    overrides_applied: int


def _position_to_letters(position: str) -> list[str]:
    if not position:
        return []
    return _POSITION_MAP.get(position.strip(), [])


def _load_overrides() -> dict:
    if not OVERRIDES_PATH.exists():
        OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
        OVERRIDES_PATH.write_text("{}\n", encoding="utf-8")
        return {}
    raw = OVERRIDES_PATH.read_text(encoding="utf-8").strip() or "{}"
    return json.loads(raw)


def _apply_overrides(
    pick: wnba_draft.DraftPick,
    proj: ProjectedTotals,
    overrides: dict,
    cfg: dict,
) -> tuple[ProjectedTotals, str | None, float | None]:
    """Override structure (per-rookie, all fields optional):
        {
            "Azzi Fudd": {
                "mpg": 30,                  # override projected MPG
                "games": 38,                # override projected games
                "points_mult": 1.10,        # multiply projected points
                "rebounds_mult": 1.0, ...,  # same for other 4 cats
                "note": "Bueckers tailwind"
            }
        }

    MPG/games overrides re-derive minutes from scratch, then re-scale all
    cats proportionally. Cat-multipliers are applied last.
    Returns (new_proj, note, override_mpg)."""
    o = overrides.get(pick.name)
    if not o:
        return proj, None, None

    new_mpg = o.get("mpg")
    new_games = o.get("games")
    if new_mpg is not None or new_games is not None:
        old_minutes = proj.minutes or 1.0
        mpg = float(new_mpg) if new_mpg is not None else (proj.minutes / max(proj.games_played, 1))
        games = int(new_games) if new_games is not None else proj.games_played
        new_minutes = mpg * games
        scale = new_minutes / old_minutes
        proj = ProjectedTotals(
            games_played=games,
            minutes=round(new_minutes, 1),
            points=round(proj.points * scale),
            rebounds=round(proj.rebounds * scale),
            assists=round(proj.assists * scale),
            steals=round(proj.steals * scale),
            blocks=round(proj.blocks * scale),
            method=proj.method,
        )

    cat_mults = {
        "points": float(o.get("points_mult", 1.0)),
        "rebounds": float(o.get("rebounds_mult", 1.0)),
        "assists": float(o.get("assists_mult", 1.0)),
        "steals": float(o.get("steals_mult", 1.0)),
        "blocks": float(o.get("blocks_mult", 1.0)),
    }
    if any(v != 1.0 for v in cat_mults.values()):
        proj = ProjectedTotals(
            games_played=proj.games_played,
            minutes=proj.minutes,
            points=round(proj.points * cat_mults["points"]),
            rebounds=round(proj.rebounds * cat_mults["rebounds"]),
            assists=round(proj.assists * cat_mults["assists"]),
            steals=round(proj.steals * cat_mults["steals"]),
            blocks=round(proj.blocks * cat_mults["blocks"]),
            method=proj.method,
        )

    override_mpg = float(new_mpg) if new_mpg is not None else None
    return proj, o.get("note"), override_mpg


def _project_pick(
    pick: wnba_draft.DraftPick,
    sess: RateLimitedSession,
    cfg: dict,
) -> tuple[ProjectedTotals, str | None]:
    """Returns (projected_totals, sportsref_slug_or_None)."""
    # Path 1: sports-reference NCAA per-40
    slug_path = sportsref_cbb.find_player_slug(pick.name, pick.college, sess)
    if slug_path:
        seasons = sportsref_cbb.fetch_player_seasons(slug_path, sess)
        latest = sportsref_cbb.latest_season(seasons)
        if latest is not None:
            proj = project_from_per_40(
                latest.pts_per_40, latest.trb_per_40, latest.ast_per_40,
                latest.stl_per_40, latest.blk_per_40,
                pick.overall_pick, cfg,
            )
            return proj, slug_path.rsplit("/", 1)[-1].removesuffix(".html")

    # Path 2: WNBA.com draft-JSON career per-game
    c = pick.career
    if c.ppg is not None:
        return project_from_career_pg(
            c.ppg, c.rpg, c.apg, c.spg, c.bpg,
            pick.overall_pick, cfg,
        ), None

    # Path 3: nothing — let manual override fill it in.
    games = int(cfg["default_games"])
    mpg = projected_mpg_for_pick(pick.overall_pick, cfg)
    zero = ProjectedTotals(
        games_played=games,
        minutes=round(mpg * games, 1),
        points=0, rebounds=0, assists=0, steals=0, blocks=0,
        method="zero",
    )
    return zero, None


def _upsert_rookie(
    db: Session,
    pick: wnba_draft.DraftPick,
    proj: ProjectedTotals,
    season: int,
    override_note: str | None,
    override_mpg: float | None,
    cfg: dict,
) -> bool:
    """Returns True if a new Player row was created (vs updated)."""
    norm = normalize_name(pick.name)
    existing = next(
        (p for p in db.scalars(select(Player)).all() if normalize_name(p.name) == norm),
        None,
    )
    proj_mpg = override_mpg if override_mpg is not None else projected_mpg_for_pick(pick.overall_pick, cfg)

    if existing is None:
        player = Player(
            name=pick.name,
            wnba_team=None,  # rookie's WNBA team isn't published until she signs
            positions=_position_to_letters(pick.position),
            is_rookie=True,
            stats_source="ncaa_projection",
            draft_pick=pick.overall_pick,
            school=pick.college or None,
            projected_mpg=proj_mpg,
            override_note=override_note,
        )
        db.add(player)
        db.flush()
        created = True
    else:
        existing.is_rookie = True
        existing.stats_source = "ncaa_projection"
        existing.draft_pick = pick.overall_pick
        existing.school = pick.college or existing.school
        existing.projected_mpg = proj_mpg
        existing.override_note = override_note
        # Don't overwrite positions if WNBA.com already set them with proper
        # dual-eligibility data — but if positions are empty, fill from draft.
        if not existing.positions:
            existing.positions = _position_to_letters(pick.position)
        player = existing
        created = False

    # Upsert StatsSeason for (player, season, 'ncaa_projection')
    stats = db.scalar(
        select(StatsSeason).where(
            StatsSeason.player_id == player.id,
            StatsSeason.season == season,
            StatsSeason.source == "ncaa_projection",
        )
    )
    fields = dict(
        games_played=proj.games_played,
        minutes=proj.minutes,
        points=proj.points,
        rebounds=proj.rebounds,
        assists=proj.assists,
        steals=proj.steals,
        blocks=proj.blocks,
    )
    if stats is None:
        db.add(StatsSeason(
            player_id=player.id, season=season, source="ncaa_projection", **fields,
        ))
    else:
        for k, v in fields.items():
            setattr(stats, k, v)
    db.flush()
    return created


def ingest_draft(
    db: Session,
    sess: RateLimitedSession,
    *,
    season: int,
    verbose: bool = True,
) -> RookieIngestStats:
    cfg = load_config()
    overrides = _load_overrides()

    picks = wnba_draft.fetch_draft_picks(season, sess)
    stats = RookieIngestStats(
        picks_total=len(picks),
        matched_ncaa=0,
        fallback_career=0,
        fallback_zero=0,
        overrides_applied=0,
    )
    for pick in picks:
        proj, slug = _project_pick(pick, sess, cfg)
        proj, note, override_mpg = _apply_overrides(pick, proj, overrides, cfg)
        if note is not None or override_mpg is not None:
            stats.overrides_applied += 1
        if proj.method == "ncaa_per_40":
            stats.matched_ncaa += 1
        elif proj.method == "career_per_game_fallback":
            stats.fallback_career += 1
        else:
            stats.fallback_zero += 1
        _upsert_rookie(db, pick, proj, season, note, override_mpg, cfg)
        if verbose:
            tag = {"ncaa_per_40": "NCAA", "career_per_game_fallback": "PG  ", "zero": "----"}[proj.method]
            print(
                f"      [{tag}] #{pick.overall_pick:>2} {pick.name:<26} "
                f"{pick.college[:18]:<18} -> {proj.points:>4} pts {proj.rebounds:>4} reb "
                f"{proj.assists:>3} ast {proj.steals:>3} stl {proj.blocks:>3} blk"
            )
    return stats
