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

from app.models import GameStats, Injury, Player, StatsSeason

CURRENT_SEASON = 2026
ROOKIE_PROJECTION_SEASON = 2026

# Once a player has at least this many 2026 games in `game_stats`, we cut
# their value-basis over from prior-year totals to current-season actuals.
# Rationale: ~10 games is enough sample to be more predictive than the
# previous season's totals, especially for rookies / role-changers / new
# coaching schemes. Below the threshold we still use prior-year so the
# FA finder + drop-candidate views aren't garbage in the first 2 weeks.
SEASON_BASIS_GAMES_THRESHOLD = 10

CATS = ("points", "rebounds", "assists", "steals", "blocks")
GAMES_FULL_SEASON = 32  # availability penalty: floor at games/32

# Vet basis selection: prefer the most recent wnba_actual season with at
# least this many games. The 2025 schedule is 44 games, so 35 is roughly
# 80% — below that the season is injury-shortened and the totals
# understate the player's expected output. Stewart (31 G in 2025) falls
# back to her healthy 2024 (38 G); Clark (13 G in 2025) likewise.
MIN_HEALTHY_GAMES = 35

DUAL_POSITION_BONUS = 1.04
TRIPLE_POSITION_BONUS = 1.08
# Rookie confidence discount applied at compute time, not ingest. PLAN.md
# placeholder was 0.70 (heavy discount). Bumped to 0.85 after the ESPN-rank
# comparison surfaced our top rookies sitting 20-40 ranks below consensus.
# Translation factors are still conservative; the lift mostly closes that
# gap without overshooting.
ROOKIE_CONFIDENCE = 0.85
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
    injury_description: str | None
    injury_return_date: str | None  # ISO date 'YYYY-MM-DD' or None
    stats_source: str         # 'wnba_actual' | 'ncaa_projection'


def _aggregate_current_season_basis(db: Session) -> dict[int, StatsSeason]:
    """Build synthetic StatsSeason rows from 2026 `game_stats` for players who
    have at least SEASON_BASIS_GAMES_THRESHOLD games. These rows are NOT
    persisted — they're constructed in-memory each call so the value engine
    can prefer current-season actuals over last year once the sample is
    meaningful.

    Returns {player_id: synthetic_row}. Players below the threshold are
    omitted; callers fall back to prior-year basis for them."""
    rows = list(db.scalars(select(GameStats).where(GameStats.season == CURRENT_SEASON)).all())
    by_player: dict[int, list[GameStats]] = {}
    for g in rows:
        by_player.setdefault(g.player_id, []).append(g)

    out: dict[int, StatsSeason] = {}
    for pid, games in by_player.items():
        if len(games) < SEASON_BASIS_GAMES_THRESHOLD:
            continue
        # Synthesize a StatsSeason-shaped row. Not persisted; the value
        # pipeline only reads cat fields + games_played.
        synth = StatsSeason(
            player_id=pid,
            season=CURRENT_SEASON,
            source="wnba_actual",
            games_played=len(games),
            minutes=sum(g.minutes for g in games),
            points=sum(g.points for g in games),
            rebounds=sum(g.rebounds for g in games),
            assists=sum(g.assists for g in games),
            steals=sum(g.steals for g in games),
            blocks=sum(g.blocks for g in games),
        )
        out[pid] = synth
    return out


# HOT marker: flag FAs whose 2026 production projects materially above their
# value basis. Threshold is an absolute lift in summed-z raw_value (i.e., the
# 2026 line, projected to a full season, would z-score ≥ HOT_RAW_LIFT higher
# than the basis row). Tunable here without touching the API.
HOT_MIN_GAMES = 3
# Raw-value lift threshold: sum-of-z difference between 2026 projection and
# basis. ~+4.0 sigma across 5 cats keeps the list short enough to be a
# "who's crushing" highlight (~30 players league-wide rather than ~60) but
# still catches role-change breakouts like Sabally, Stokes, Carleton, who
# are running a clear tier above their 2025 baseline.
HOT_RAW_LIFT = 4.0
HOT_PROJECT_GAMES = 44  # WNBA 2026 regular season length


def _project_2026_full_season(db: Session) -> dict[int, StatsSeason]:
    """Like `_aggregate_current_season_basis` but with a lower GP floor — used
    only for the HOT marker, not value scoring. Each player's 2026 per-game
    rates are scaled to HOT_PROJECT_GAMES so they're comparable to a full-
    season basis row."""
    rows = list(db.scalars(select(GameStats).where(GameStats.season == CURRENT_SEASON)).all())
    by_player: dict[int, list[GameStats]] = {}
    for g in rows:
        by_player.setdefault(g.player_id, []).append(g)

    out: dict[int, StatsSeason] = {}
    for pid, games in by_player.items():
        gp = len(games)
        if gp < HOT_MIN_GAMES:
            continue
        scale = HOT_PROJECT_GAMES / gp
        out[pid] = StatsSeason(
            player_id=pid,
            season=CURRENT_SEASON,
            source="wnba_actual",
            games_played=HOT_PROJECT_GAMES,
            minutes=sum(g.minutes for g in games) * scale,
            points=int(sum(g.points for g in games) * scale),
            rebounds=int(sum(g.rebounds for g in games) * scale),
            assists=int(sum(g.assists for g in games) * scale),
            steals=int(sum(g.steals for g in games) * scale),
            blocks=int(sum(g.blocks for g in games) * scale),
        )
    return out


def _basis_stats_by_player(db: Session) -> dict[int, StatsSeason]:
    """For each player, pick the StatsSeason row used as their value basis.

    Priority:
      1. **Current-season actuals** if the player has >= SEASON_BASIS_GAMES_THRESHOLD
         games in `game_stats` for the current season. Synthesized in-memory
         from the per-game logs (CP7); not persisted.
      2. Most recent prior-year `wnba_actual` with G >= MIN_HEALTHY_GAMES,
         falling back to the most recent of any size if no healthy year exists.
         (Clark 2024, Stewart 2025-or-2024 depending on G.)
      3. Rookie projection (season=ROOKIE_PROJECTION_SEASON, source='ncaa_projection')
         used only when a player has no wnba_actual rows of any season.

    The current-season cutover (#1) is what makes the in-season FA finder
    and drop-candidate views useful — once a player has accumulated real
    2026 data, that drives their value, not last year.
    """
    out: dict[int, StatsSeason] = {}

    # 1) Current-season actuals (CP10).
    out.update(_aggregate_current_season_basis(db))

    # 2) Prior-year wnba_actual fallback for anyone not in (1).
    vet_by_player: dict[int, list[StatsSeason]] = {}
    for s in db.scalars(select(StatsSeason).where(StatsSeason.source == "wnba_actual")).all():
        vet_by_player.setdefault(s.player_id, []).append(s)
    for pid, rows in vet_by_player.items():
        if pid in out:
            continue
        rows.sort(key=lambda r: r.season, reverse=True)
        healthy = next((r for r in rows if r.games_played >= MIN_HEALTHY_GAMES), None)
        out[pid] = healthy or rows[0]

    # 3) Rookie projection if no actuals at all.
    for s in db.scalars(
        select(StatsSeason).where(
            StatsSeason.season == ROOKIE_PROJECTION_SEASON,
            StatsSeason.source == "ncaa_projection",
        )
    ).all():
        out.setdefault(s.player_id, s)

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
            injury_description=inj.description if inj else None,
            injury_return_date=inj.return_date.isoformat() if inj and inj.return_date else None,
            stats_source=stats.source,
        ))

    out.sort(key=lambda v: v.value, reverse=True)
    return out


def compute_hot_player_ids(db: Session) -> set[int]:
    """Return the set of player_ids whose 2026 production, projected to a
    full season, would z-score noticeably above their value basis. Used by
    the Players API to surface "who's crushing" without changing the value
    ordering (which still uses the conservative basis logic).

    Math:
      - For each player with >= HOT_MIN_GAMES 2026 games, scale their
        per-game line to a 44-game season.
      - Z-score the projected line against the SAME baseline used by the
        basis row (so the comparison is apples-to-apples).
      - HOT if sum-of-z (projected) - sum-of-z (basis) >= HOT_RAW_LIFT.
      - Players already on a 2026 basis (>=10 GP) only flag HOT if their
        projection still beats their own basis by HOT_RAW_LIFT — i.e., a
        within-2026 surge above what's already baked in. Usually they
        won't (basis ~= projection by construction), which is the right
        behavior: their value already reflects the hot start.
    """
    basis = _basis_stats_by_player(db)
    if not basis:
        return set()
    projections = _project_2026_full_season(db)
    if not projections:
        return set()

    mu_sigma = _compute_zscore_baseline(list(basis.values()))

    def raw_value(row: StatsSeason) -> float:
        return sum(
            (getattr(row, cat) - mu_sigma[cat][0]) / mu_sigma[cat][1]
            for cat in CATS
        )

    hot: set[int] = set()
    for pid, proj in projections.items():
        basis_row = basis.get(pid)
        if basis_row is None:
            continue
        if raw_value(proj) - raw_value(basis_row) >= HOT_RAW_LIFT:
            hot.add(pid)
    return hot


# ----- team-context-aware (rotis) value -----

# 2024 final standings showed: top teams had 0 last-place finishes; a single
# punted category sinks rotis rank-sum. So we boost the weight on cats where
# my team is behind pace, encouraging the draft to fill weak cats over
# stacking strengths I've already locked.
DEFAULT_DEFICIT_BIAS = 0.5

# Roster shape used for pace targets — must stay in sync with draft router.
PICKS_PER_TEAM = 6


def compute_pace_targets(
    values: list[PlayerValue],
    n_teams: int,
    picks_per_team: int = PICKS_PER_TEAM,
) -> dict[str, float]:
    """Per-team end-of-draft target for each of the 5 cats.

    Take the top (n_teams × picks_per_team) basis-stat rows by absolute value
    (proxy for "who will actually be drafted"), sum each cat, divide by
    n_teams. A team finishing at this pace would be the league average."""
    pool_size = n_teams * picks_per_team
    pool = sorted(values, key=lambda v: v.value, reverse=True)[:pool_size]
    if not pool or n_teams <= 0:
        return {c: 0.0 for c in CATS}
    return {
        c: sum(getattr(v, c) for v in pool) / n_teams
        for c in CATS
    }


def aggregate_team_totals(
    values: list[PlayerValue],
    rostered_player_ids: set[int],
) -> dict[str, int]:
    """Sum basis-stat cat totals across a given set of players."""
    out = {c: 0 for c in CATS}
    for v in values:
        if v.player_id not in rostered_player_ids:
            continue
        for c in CATS:
            out[c] += getattr(v, c)
    return out


def compute_marginal_value(
    pv: PlayerValue,
    team_totals: dict[str, int],
    pace_targets: dict[str, float],
    picks_made_by_team: int,
    picks_per_team: int = PICKS_PER_TEAM,
    bias: float = DEFAULT_DEFICIT_BIAS,
) -> float:
    """A z-score sum where cats my team is *behind pace so far* get extra
    weight. Pace-so-far = pace_target × (my_picks / picks_per_team).

    Per-cat weight = 1 + bias × deficit_share, where deficit_share is
    clamped to [0, 1]. Pre-draft (0 picks): expected = 0, deficit = 0,
    weight = 1.0 — marginal collapses to absolute value cleanly. On
    pace: weight = 1.0. Behind pace: weight up to 1 + bias.
    """
    final = 0.0
    for c in CATS:
        target = pace_targets.get(c, 0.0)
        cur = team_totals.get(c, 0)
        expected_so_far = target * (picks_made_by_team / picks_per_team) if picks_per_team else 0.0
        if expected_so_far > 0:
            deficit_share = max(0.0, min(1.0, (expected_so_far - cur) / expected_so_far))
        else:
            deficit_share = 0.0
        weight = 1.0 + bias * deficit_share
        z = getattr(pv, f"z_{c}")
        final += z * weight
    return final


def compute_weighted_value(
    pv: PlayerValue,
    cat_weights: dict[str, float],
) -> float:
    """Recompute a player's value using per-cat z-score weights instead of a
    flat sum. Mirrors `compute_marginal_value` but for in-season strategy
    weighting (CP14): the strategy view classifies each cat as Lock / Contend
    / Punt and emits weights (0.4 / 1.5 / 0.0); apply them here so a FA whose
    contributions are all in punted cats ranks correctly low for my team.

    Multiplies the same availability / position / injury / rookie factors
    through that `compute_player_values` applies, so the only difference vs
    `pv.value` is the per-cat reweighting of the raw z-score sum."""
    weighted_raw = sum(
        getattr(pv, f"z_{c}") * cat_weights.get(c, 1.0) for c in CATS
    )
    return (
        weighted_raw
        * pv.availability_factor
        * pv.position_factor
        * pv.injury_factor
        * pv.rookie_factor
    )


def per_cat_pace_status(
    team_totals: dict[str, int],
    pace_targets: dict[str, float],
    picks_made_by_team: int,
    picks_per_team: int = PICKS_PER_TEAM,
) -> dict[str, dict]:
    """For the cat-strength panel: for each cat, show current / expected
    so far and a 0-1 ratio that the UI colors red/amber/green.

    Expected-so-far = pace_target × (picks_made / picks_per_team) — a
    linear ramp toward the end-of-draft target."""
    out: dict[str, dict] = {}
    for c in CATS:
        target = pace_targets.get(c, 0.0)
        expected_so_far = target * (picks_made_by_team / picks_per_team) if picks_per_team else 0.0
        cur = team_totals.get(c, 0)
        ratio = (cur / expected_so_far) if expected_so_far > 0 else (1.0 if cur == 0 else float("inf"))
        out[c] = {
            "current": cur,
            "target_end_of_draft": round(target, 1),
            "expected_so_far": round(expected_so_far, 1),
            "ratio": round(ratio, 3) if ratio != float("inf") else None,
        }
    return out
