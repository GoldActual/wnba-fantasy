"""Project rookie WNBA season totals from college stats.

Two paths into a `ProjectedTotals`:

1. **NCAA path** — preferred. Take last-season per-40 from sports-reference,
   apply translation factors (NCAA → WNBA per-40), scale to projected
   WNBA MPG and games. Rigorous and trust-worthy when available.

2. **Career-PG fallback** — for international or no-NCAA-data picks.
   Use the career per-game line embedded in the WNBA.com draft JSON,
   apply translation factors, scale by projected-MPG / assumed-college-MPG.
   Cruder; flag the rookie for manual override.

All knobs (translation factors, MPG buckets, assumed college MPG, default
games) live in `data/projection_config.json` so they can be tuned without
code changes. The file is created with PLAN.md defaults on first import.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.config import DATA_DIR

_CONFIG_PATH = DATA_DIR / "projection_config.json"

# PLAN.md starting values. Per-40 (women's CBB and WNBA both use 40-minute
# games — the per-36 phrasing in the original plan was an NBA carryover).
_DEFAULT_CONFIG = {
    "_comment": (
        "Tunable knobs for rookie projection. Multipliers are NCAA per-40 -> "
        "WNBA per-40 translation factors. Edit and re-run scripts/refresh.py "
        "(or scripts/report.py for a no-scrape recompute)."
    ),
    "translation_factors": {
        "points": 0.55,
        "rebounds": 0.70,
        "assists": 0.60,
        "steals": 0.50,
        "blocks": 0.50,
    },
    "mpg_buckets": [
        # [overall_pick_min, overall_pick_max_inclusive, projected_mpg]
        [1, 4, 27.5],   # PLAN range 25-30 — likely starters on rebuilders/expansion
        [5, 12, 21.5],  # 18-25 — first-round rotation
        [13, 24, 11.5], # 8-15 — bench/situational
        [25, 99, 4.0],  # 0-8 — fringe
    ],
    "default_games": 36,
    # For the career-per-game fallback only: what we *assume* the college
    # player averaged in MPG. Top-tier college starters cluster around 30.
    "assumed_college_mpg_for_fallback": 30.0,
}


@dataclass(frozen=True)
class ProjectedTotals:
    games_played: int
    minutes: float
    points: int
    rebounds: int
    assists: int
    steals: int
    blocks: int
    method: str  # 'ncaa_per_40' | 'career_per_game_fallback'


def load_config() -> dict:
    """Read the projection config, creating it from defaults on first use."""
    if not _CONFIG_PATH.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _CONFIG_PATH.write_text(json.dumps(_DEFAULT_CONFIG, indent=2), encoding="utf-8")
        return _DEFAULT_CONFIG
    return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))


def projected_mpg_for_pick(overall_pick: int, cfg: dict | None = None) -> float:
    cfg = cfg or load_config()
    for lo, hi, mpg in cfg["mpg_buckets"]:
        if lo <= overall_pick <= hi:
            return float(mpg)
    return float(cfg["mpg_buckets"][-1][2])


def project_from_per_40(
    pts40: float, reb40: float, ast40: float, stl40: float, blk40: float,
    overall_pick: int,
    cfg: dict | None = None,
) -> ProjectedTotals:
    """NCAA per-40 -> projected WNBA season totals.

    WNBA_per40 = NCAA_per40 * factor
    WNBA_per_game = WNBA_per40 * (proj_mpg / 40)
    season_total  = WNBA_per_game * games
    """
    cfg = cfg or load_config()
    f = cfg["translation_factors"]
    games = int(cfg["default_games"])
    mpg = projected_mpg_for_pick(overall_pick, cfg)
    minutes_total = mpg * games

    def total(per40: float, factor: float) -> float:
        return per40 * factor * (minutes_total / 40.0)

    return ProjectedTotals(
        games_played=games,
        minutes=round(minutes_total, 1),
        points=round(total(pts40, f["points"])),
        rebounds=round(total(reb40, f["rebounds"])),
        assists=round(total(ast40, f["assists"])),
        steals=round(total(stl40, f["steals"])),
        blocks=round(total(blk40, f["blocks"])),
        method="ncaa_per_40",
    )


def project_from_career_pg(
    ppg: float | None, rpg: float | None, apg: float | None,
    spg: float | None, bpg: float | None,
    overall_pick: int,
    cfg: dict | None = None,
) -> ProjectedTotals:
    """Career-per-game fallback for picks with no NCAA per-40 data.

    Treats the source per-game stat as having been generated at the
    'assumed_college_mpg_for_fallback' rate, scales to projected WNBA
    minutes, then applies the same translation factors. Missing cats
    (commonly SPG/BPG for internationals) project to 0.
    """
    cfg = cfg or load_config()
    f = cfg["translation_factors"]
    games = int(cfg["default_games"])
    proj_mpg = projected_mpg_for_pick(overall_pick, cfg)
    college_mpg = float(cfg["assumed_college_mpg_for_fallback"])
    minutes_total = proj_mpg * games
    mpg_ratio = proj_mpg / college_mpg if college_mpg else 0.0

    def total(pg: float | None, factor: float) -> float:
        if pg is None:
            return 0.0
        return pg * factor * mpg_ratio * games

    return ProjectedTotals(
        games_played=games,
        minutes=round(minutes_total, 1),
        points=round(total(ppg, f["points"])),
        rebounds=round(total(rpg, f["rebounds"])),
        assists=round(total(apg, f["assists"])),
        steals=round(total(spg, f["steals"])),
        blocks=round(total(bpg, f["blocks"])),
        method="career_per_game_fallback",
    )
