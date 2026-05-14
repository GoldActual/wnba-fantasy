"""Cat-targeting strategy analysis (CP13).

Layered on top of `standings.compute_standings`. Two outputs per team:
  1. Per-cat classification (Lock / Contend / Punt) with projected rank,
     gap-up/gap-down, and a suggested weight for FA reweighting (CP14).
  2. Head-to-head: pairwise per-cat diff vs every other team, so the
     user can see "where do I beat Sean, where am I losing" at a glance.

Why this matters: with only 4 transactions per season, the win path is
"be excellent in 3-4 cats, abandon 1-2" — not "be balanced everywhere".
The classifier identifies which cats deserve a transaction and which
don't.

Math:
  - Project each cat to end-of-season: current_total * 44 / team_games.
    Re-rank teams on those projected totals to get projected_rank.
  - gap_up = my_projected - team_above_projected (negative when chasing)
  - gap_down = my_projected - team_below_projected (positive = lead)
  - Lock if projected #1 with gap_down >= LOCK_GAP_MARGIN of my_projected
  - Punt if projected in bottom-N with deficit to team_above >= PUNT_GAP_MARGIN
  - Contend everything else
  - `low_sample` flag set when avg team_games < 10; UI shows a warning
    so the user knows the classifications are early-season-noisy.

Thresholds are tunable constants. Live in this module rather than a
config file for now; promote to JSON in a follow-up if the user wants
to adjust them mid-season without a code edit.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy.orm import Session

from app.standings import (
    CATS,
    _rank_with_ties,
    compute_standings,
)

Classification = Literal["lock", "contend", "punt"]

LOW_SAMPLE_THRESHOLD = 10           # avg team_games below this -> low_sample flag
LOCK_GAP_MARGIN = 0.15              # gap_down >= 15% of my_projected -> Lock
PUNT_GAP_MARGIN = 0.25              # |gap_up| >= 25% of team_above -> Punt
PUNT_BOTTOM_N = 3                   # only ranks in bottom-N can be Punt
# Lock qualifier: no team strictly above me (so I'm at the top, tied or alone).
# Encoded via gap_up is None rather than a rank threshold to keep ties-for-#1
# eligible — being tied 1.5 with one other team is still "at the top".

# Suggested weights for the CP14 FA-value reweighting hook.
WEIGHTS: dict[Classification, float] = {
    "lock": 0.4,
    "contend": 1.5,
    "punt": 0.0,
}


@dataclass(frozen=True)
class CatStrategy:
    cat: str
    current_total: int
    current_rank: float
    projected_total: int
    projected_rank: float
    gap_up: float | None      # my_projected - team_above_projected; None if #1
    gap_down: float | None    # my_projected - team_below_projected; None if last
    classification: Classification
    weight: float


@dataclass(frozen=True)
class H2HCat:
    cat: str
    my_total: int
    opp_total: int
    current_gap: int            # my - opp
    my_projected: int
    opp_projected: int
    projected_gap: int          # my_projected - opp_projected
    status: Literal["winning", "tied", "losing"]   # based on projected_gap


@dataclass(frozen=True)
class HeadToHead:
    opp_team_id: int
    opp_team_name: str
    opp_rank_sum: float
    opp_standing: float
    cats: list[H2HCat]
    cats_winning: int
    cats_losing: int
    cats_tied: int


@dataclass(frozen=True)
class TeamStrategy:
    team_id: int
    team_name: str
    is_my_team: bool
    team_games_played: int
    avg_team_games: float
    low_sample: bool
    rank_sum: float
    standing: float
    cats: list[CatStrategy]
    head_to_head: list[HeadToHead]


def _gap_to_neighbors(
    my_projected: int, all_projected: list[int]
) -> tuple[float | None, float | None]:
    """Returns (gap_up, gap_down). gap_up < 0 means I'm chasing; gap_down > 0
    means I have a lead. None when there's no team strictly above/below."""
    strictly_above = sorted(v for v in all_projected if v > my_projected)
    strictly_below = sorted((v for v in all_projected if v < my_projected), reverse=True)
    gap_up = float(my_projected - strictly_above[0]) if strictly_above else None
    gap_down = float(my_projected - strictly_below[0]) if strictly_below else None
    return gap_up, gap_down


def _classify(
    projected_rank: float,
    gap_up: float | None,
    gap_down: float | None,
    my_projected: int,
    num_teams: int,
) -> Classification:
    if my_projected <= 0:
        return "contend"
    # Lock: nobody strictly above me AND a safe lead over the next team below.
    if gap_up is None and gap_down is not None:
        if gap_down >= LOCK_GAP_MARGIN * my_projected:
            return "lock"
    bottom_threshold = num_teams - PUNT_BOTTOM_N + 1
    if projected_rank >= bottom_threshold and gap_up is not None:
        team_above_projected = my_projected - gap_up  # gap_up = my - above
        if team_above_projected > 0 and abs(gap_up) >= PUNT_GAP_MARGIN * team_above_projected:
            return "punt"
    return "contend"


def analyze_team(
    db: Session,
    team_id: int,
    season: int = 2026,
) -> TeamStrategy:
    """Compute strategy + head-to-head for a single team. Raises ValueError
    if the team isn't found."""
    standings = compute_standings(db, season=season)
    if not standings.teams:
        raise ValueError("No teams configured")
    me = next((t for t in standings.teams if t.team_id == team_id), None)
    if me is None:
        raise ValueError(f"team_id {team_id} not found")

    num_teams = len(standings.teams)
    avg_team_games = sum(t.games_played for t in standings.teams) / num_teams
    low_sample = avg_team_games < LOW_SAMPLE_THRESHOLD

    # Re-rank teams on projected totals (compute_standings only ranks on current)
    projected_totals_by_cat: dict[str, dict[int, int]] = {}
    projected_ranks_by_cat: dict[str, dict[int, float]] = {}
    for c in CATS:
        projected_totals_by_cat[c] = {t.team_id: t.cats[c].projected for t in standings.teams}
        projected_ranks_by_cat[c] = _rank_with_ties(
            {tid: float(p) for tid, p in projected_totals_by_cat[c].items()}
        )

    cat_strategies: list[CatStrategy] = []
    for c in CATS:
        my_cat = me.cats[c]
        my_projected = my_cat.projected
        gap_up, gap_down = _gap_to_neighbors(
            my_projected, list(projected_totals_by_cat[c].values())
        )
        projected_rank = projected_ranks_by_cat[c][team_id]
        classification = _classify(
            projected_rank=projected_rank,
            gap_up=gap_up,
            gap_down=gap_down,
            my_projected=my_projected,
            num_teams=num_teams,
        )
        cat_strategies.append(CatStrategy(
            cat=c,
            current_total=my_cat.total,
            current_rank=my_cat.rank,
            projected_total=my_projected,
            projected_rank=projected_rank,
            gap_up=gap_up,
            gap_down=gap_down,
            classification=classification,
            weight=WEIGHTS[classification],
        ))

    # Head-to-head vs every other team
    h2hs: list[HeadToHead] = []
    for opp in standings.teams:
        if opp.team_id == team_id:
            continue
        h2h_cats: list[H2HCat] = []
        wins = losses = ties = 0
        for c in CATS:
            my_proj = me.cats[c].projected
            opp_proj = opp.cats[c].projected
            projected_gap = my_proj - opp_proj
            if projected_gap > 0:
                status: Literal["winning", "tied", "losing"] = "winning"
                wins += 1
            elif projected_gap < 0:
                status = "losing"
                losses += 1
            else:
                status = "tied"
                ties += 1
            h2h_cats.append(H2HCat(
                cat=c,
                my_total=me.cats[c].total,
                opp_total=opp.cats[c].total,
                current_gap=me.cats[c].total - opp.cats[c].total,
                my_projected=my_proj,
                opp_projected=opp_proj,
                projected_gap=projected_gap,
                status=status,
            ))
        h2hs.append(HeadToHead(
            opp_team_id=opp.team_id,
            opp_team_name=opp.team_name,
            opp_rank_sum=opp.rank_sum,
            opp_standing=opp.standing,
            cats=h2h_cats,
            cats_winning=wins,
            cats_losing=losses,
            cats_tied=ties,
        ))
    h2hs.sort(key=lambda h: (h.opp_standing, h.opp_team_name))

    return TeamStrategy(
        team_id=me.team_id,
        team_name=me.team_name,
        is_my_team=me.is_my_team,
        team_games_played=me.games_played,
        avg_team_games=round(avg_team_games, 1),
        low_sample=low_sample,
        rank_sum=me.rank_sum,
        standing=me.standing,
        cats=cat_strategies,
        head_to_head=h2hs,
    )
