"""Z-score value calculation for the 5-cat fantasy league.

Per PLAN.md:
  1. Z-score each player vs the league mean in PTS, REB, AST, STL, BLK
     (using season totals).
  2. Sum the 5 z-scores -> raw value.
  3. Multiply by min(1, games / 32) -> availability penalty.
  4. Position bonuses: dual ×1.04, triple ×1.08.
  5. Injury: status='Out' / 'Out For Season' -> ×0.4.
  6. Rookies: ×0.7 confidence discount, then any per-cat or note overrides
     (those are already baked into the projected stats by app/rookies.py).

Stat basis per player:
  - Veteran -> 2025 actuals    (StatsSeason source='wnba_actual',  season=VETERAN_BASIS_SEASON)
  - Rookie  -> 2026 projection (StatsSeason source='ncaa_projection', season=ROOKIE_PROJECTION_SEASON)

The z-score baseline pool is *every player* with a basis row (vets + rookies
together). PLAN.md note: "default to all players in the DB; revisit if
rankings look off."
"""
from __future__ import annotations

from dataclasses import dataclass
from statistics import mean, pstdev

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Injury, Player, StatsSeason

ROOKIE_PROJECTION_SEASON = 2026

CATS = ("points", "rebounds", "assists", "steals", "blocks")
GAMES_FULL_SEASON = 32  # availability penalty: floor at games/32

# Vet basis selection: prefer the most recent wnba_actual season with at
# least this many games. Picks like Clark (13 G in 2025) and Stewart (31 G)
# fall back to their last healthy year. Below this threshold the sample is
# too injury-noisy to trust as a single-season projection.
MIN_HEALTHY_GAMES = 25

DUAL_POSITION_BONUS = 1.04
TRIPLE_POSITION_BONUS = 1.08
ROOKIE_CONFIDENCE = 0.70
OUT_INJURY_PENALTY = 0.40
OUT_STATUSES = {"out", "out for season"}


@dataclass(frozen=True)
class PlayerValue:
    player_id: int
    name: str
    positions: tuple[str, ...]
    wnba_team: str | None
    is_rookie: bool
    draft_pick: int | None
    school: str | None
    projected_mpg: float | None
    override_note: str | None

    games_played: int
    points: int
    rebounds: int
    assists: int
    steals: int
    blocks: int

    z_points: float
    z_rebounds: float
    z_assists: float
    z_steals: float
    z_blocks: float

    raw_value: float          # sum of 5 z-scores
    availability_factor: float
    position_factor: float
    injury_factor: float
    rookie_factor: float
    value: float              # final score (everything multiplied in)

    injury_status: str | None
    stats_source: str         # 'wnba_actual' | 'ncaa_projection'


def _basis_stats_by_player(db: Session) -> dict[int, StatsSeason]:
    """For each player, pick the StatsSeason row used as their value basis.

    Vet basis = the most recent `wnba_actual` season with G >= MIN_HEALTHY_GAMES,
    falling back to the most recent of any size if no healthy year exists.
    This way Clark (13 G in 2025) and Stewart (31 G) get evaluated on their
    last full season instead of an injury-noise sample.

    Rookie basis = (season=ROOKIE_PROJECTION_SEASON, source='ncaa_projection'),
    used only when a player has no wnba_actual rows — real stats always
    trump projection.
    """
    out: dict[int, StatsSeason] = {}

    vet_by_player: dict[int, list[StatsSeason]] = {}
    for s in db.scalars(select(StatsSeason).where(StatsSeason.source == "wnba_actual")).all():
        vet_by_player.setdefault(s.player_id, []).append(s)
    for pid, rows in vet_by_player.items():
        rows.sort(key=lambda r: r.season, reverse=True)  # newest first
        healthy = next((r for r in rows if r.games_played >= MIN_HEALTHY_GAMES), None)
        out[pid] = healthy or rows[0]

    for s in db.scalars(
        select(StatsSeason).where(
            StatsSeason.season == ROOKIE_PROJECTION_SEASON,
            StatsSeason.source == "ncaa_projection",
        )
    ).all():
        out.setdefault(s.player_id, s)  # don't overwrite a wnba_actual row

    return out


def _compute_zscore_baseline(rows: list[StatsSeason]) -> dict[str, tuple[float, float]]:
    """Return {cat: (mean, stdev)} across the basis pool. Population stdev
    so a single player with the league mean gets z=0."""
    out: dict[str, tuple[float, float]] = {}
    for cat in CATS:
        values = [getattr(r, cat) for r in rows]
        if not values:
            out[cat] = (0.0, 1.0)
            continue
        mu = mean(values)
        sigma = pstdev(values) or 1.0  # avoid div-by-zero on degenerate pool
        out[cat] = (mu, sigma)
    return out


def _position_factor(positions: list[str]) -> float:
    n = len({p for p in positions if p})
    if n >= 3:
        return TRIPLE_POSITION_BONUS
    if n == 2:
        return DUAL_POSITION_BONUS
    return 1.0


def _injury_factor(status: str | None) -> float:
    if not status:
        return 1.0
    return OUT_INJURY_PENALTY if status.strip().lower() in OUT_STATUSES else 1.0


def compute_player_values(db: Session) -> list[PlayerValue]:
    """Run the value formula for every player with a basis stat row.
    Returns the list sorted by `value` desc."""
    basis = _basis_stats_by_player(db)
    if not basis:
        return []

    means_stdevs = _compute_zscore_baseline(list(basis.values()))

    injuries_by_pid = {
        i.player_id: i
        for i in db.scalars(select(Injury).where(Injury.player_id.is_not(None))).all()
    }
    players = {p.id: p for p in db.scalars(select(Player)).all()}

    out: list[PlayerValue] = []
    for pid, stats in basis.items():
        p = players.get(pid)
        if p is None:
            continue
        zs: dict[str, float] = {}
        for cat in CATS:
            mu, sigma = means_stdevs[cat]
            zs[cat] = (getattr(stats, cat) - mu) / sigma

        raw = sum(zs.values())
        availability = min(1.0, stats.games_played / GAMES_FULL_SEASON) if stats.games_played else 0.0
        pos_factor = _position_factor(p.positions or [])
        inj = injuries_by_pid.get(pid)
        inj_factor = _injury_factor(inj.status if inj else None)
        rookie_factor = ROOKIE_CONFIDENCE if p.is_rookie else 1.0

        value = raw * availability * pos_factor * inj_factor * rookie_factor

        out.append(PlayerValue(
            player_id=pid,
            name=p.name,
            positions=tuple(p.positions or []),
            wnba_team=p.wnba_team,
            is_rookie=p.is_rookie,
            draft_pick=p.draft_pick,
            school=p.school,
            projected_mpg=p.projected_mpg,
            override_note=p.override_note,
            games_played=stats.games_played,
            points=stats.points,
            rebounds=stats.rebounds,
            assists=stats.assists,
            steals=stats.steals,
            blocks=stats.blocks,
            z_points=zs["points"],
            z_rebounds=zs["rebounds"],
            z_assists=zs["assists"],
            z_steals=zs["steals"],
            z_blocks=zs["blocks"],
            raw_value=raw,
            availability_factor=availability,
            position_factor=pos_factor,
            injury_factor=inj_factor,
            rookie_factor=rookie_factor,
            value=value,
            injury_status=inj.status if inj else None,
            stats_source=stats.source,
        ))

    out.sort(key=lambda v: v.value, reverse=True)
    return out
