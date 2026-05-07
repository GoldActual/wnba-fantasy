"""CP11 — drop+add transaction simulator.

Answers: "if I drop player X for free agent Y on team T, what would the
standings look like?" Pure read model — does not write to the DB.

Attribution model is **all-season retroactive (option A)**: we pretend
the swap was in place from day 1. Every team's totals come from
`aggregate_team_totals` over the *current* roster (after swap, for the
picking team), summing all 2026 game_stats. This intentionally diverges
slightly from the live scoreboard for any team that has executed a
backdated trade — the live view honors ownership timelines, but the
simulator's "before" baseline pretends current rosters were always
current. That's the right framing for "would I be better off going
forward?" and keeps before/after directly comparable.

Note: in this league there are no team-to-team trades — every "trade"
is a 1-for-1 drop-rostered + add-FA. So the dropped player's stats
simply vanish from this team in the after-world (they hit FA, no other
team picks them up in this hypothetical). The added FA's full-season
stats credit to the picking team.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import GameStats, Player, Roster, Team
from app.standings import (
    CATS,
    CURRENT_SEASON,
    FULL_SEASON_GAMES,
    _project_total,
    _rank_with_ties,
    aggregate_team_totals,
)


class SimulatorError(ValueError):
    pass


@dataclass(frozen=True)
class SimCatLine:
    total: int
    rank: float
    projected: int


@dataclass(frozen=True)
class SimTeam:
    team_id: int
    team_name: str
    is_my_team: bool
    draft_slot: int
    rank_sum: float
    standing: float
    team_games: int
    cats: dict[str, SimCatLine]


@dataclass(frozen=True)
class SimWorld:
    teams: list[SimTeam]


@dataclass(frozen=True)
class SimResult:
    season: int
    full_season_games: int
    league_games_to_date: int
    picking_team_id: int
    drop_player_id: int
    drop_player_name: str
    add_player_id: int
    add_player_name: str
    before: SimWorld
    after: SimWorld


def _games_per_player(db: Session, season: int) -> dict[int, int]:
    counts: dict[int, int] = {}
    for g in db.scalars(select(GameStats).where(GameStats.season == season)).all():
        counts[g.player_id] = counts.get(g.player_id, 0) + 1
    return counts


def _build_world(
    db: Session,
    teams: list[Team],
    team_player_map: dict[int, set[int]],
    games_by_player: dict[int, int],
    season: int,
) -> SimWorld:
    totals = aggregate_team_totals(db, team_player_map, season=season)

    cat_ranks: dict[str, dict[int, float]] = {
        c: _rank_with_ties({tid: float(totals[tid][c]) for tid in totals})
        for c in CATS
    }
    rank_sums = {tid: sum(cat_ranks[c][tid] for c in CATS) for tid in totals}
    overall = _rank_with_ties({tid: -rs for tid, rs in rank_sums.items()})

    team_games = {
        tid: max((games_by_player.get(pid, 0) for pid in pids), default=0)
        for tid, pids in team_player_map.items()
    }

    out: list[SimTeam] = []
    for t in teams:
        cats = {
            c: SimCatLine(
                total=totals[t.id][c],
                rank=cat_ranks[c][t.id],
                projected=_project_total(totals[t.id][c], team_games[t.id], FULL_SEASON_GAMES),
            )
            for c in CATS
        }
        out.append(SimTeam(
            team_id=t.id,
            team_name=t.name,
            is_my_team=t.is_my_team,
            draft_slot=t.draft_slot,
            rank_sum=rank_sums[t.id],
            standing=overall[t.id],
            team_games=team_games[t.id],
            cats=cats,
        ))
    out.sort(key=lambda x: (x.standing, x.rank_sum, x.team_name))
    return SimWorld(teams=out)


def simulate_pickup(
    db: Session,
    *,
    team_id: int,
    drop_player_id: int,
    add_player_id: int,
    season: int = CURRENT_SEASON,
) -> SimResult:
    if drop_player_id == add_player_id:
        raise SimulatorError("add and drop players must differ")

    teams = list(
        db.scalars(
            select(Team).where(Team.is_active.is_(True)).order_by(Team.draft_slot)
        ).all()
    )
    if not any(t.id == team_id for t in teams):
        raise SimulatorError(f"team {team_id} not found or inactive")

    drop_p = db.get(Player, drop_player_id)
    add_p = db.get(Player, add_player_id)
    if drop_p is None:
        raise SimulatorError(f"drop_player_id {drop_player_id} not found")
    if add_p is None:
        raise SimulatorError(f"add_player_id {add_player_id} not found")

    rosters_by_team: dict[int, set[int]] = {t.id: set() for t in teams}
    pid_to_team: dict[int, int] = {}
    for r in db.scalars(select(Roster)).all():
        rosters_by_team.setdefault(r.team_id, set()).add(r.player_id)
        pid_to_team[r.player_id] = r.team_id

    if drop_player_id not in rosters_by_team.get(team_id, set()):
        owner = pid_to_team.get(drop_player_id)
        if owner is None:
            raise SimulatorError(f"{drop_p.name} is a free agent — nothing to drop")
        raise SimulatorError(f"{drop_p.name} is on a different team (team_id={owner})")
    if add_player_id in pid_to_team:
        raise SimulatorError(
            f"{add_p.name} is currently rostered (team_id={pid_to_team[add_player_id]})"
        )

    before_map = {tid: set(pids) for tid, pids in rosters_by_team.items()}
    after_map = {tid: set(pids) for tid, pids in rosters_by_team.items()}
    after_map[team_id] = (after_map[team_id] - {drop_player_id}) | {add_player_id}

    games_by_player = _games_per_player(db, season)
    league_games = max(games_by_player.values(), default=0)

    return SimResult(
        season=season,
        full_season_games=FULL_SEASON_GAMES,
        league_games_to_date=league_games,
        picking_team_id=team_id,
        drop_player_id=drop_player_id,
        drop_player_name=drop_p.name,
        add_player_id=add_player_id,
        add_player_name=add_p.name,
        before=_build_world(db, teams, before_map, games_by_player, season),
        after=_build_world(db, teams, after_map, games_by_player, season),
    )
