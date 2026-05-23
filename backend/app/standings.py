"""Live rotisserie scoreboard for the in-season scoreboard view.

Reads `game_stats` (CP7) joined to current ownership in `rosters`, sums
the 5 cats per team, and ranks. Per the league rule (PLAN.md): each cat
is ranked 1..N across teams (highest cat total = rank 1), the 5 ranks
sum, and the lowest rank-sum wins.

Ties: rotisserie convention is to give tied teams the average of the
ranks they would have occupied. Two teams tied at 1st-2nd both get rank
1.5; pre-season when every team is at 0, all 8 teams tie and each gets
rank (1+2+...+N)/N = (N+1)/2 in every cat. Pre-season rank-sum =
5 × (N+1)/2 — every team identical, all tied for 1st. Exactly what the
"start at 0" rule wants.

Backdated trades: honored as of CP9. Each game's stats attribute to
whichever team owned the player on the game's date, derived from the
transactions ledger (`app/transactions.py::build_ownership_timelines`).
A player traded mid-stint splits cleanly between owners with no manual
intervention. `aggregate_team_totals(team_player_map)` (kept for the
CP11 simulator) is a *hypothetical-rosters* helper that ignores history
— use that when answering "if these were the rosters today, ...".
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import GameStats, Injury, Player, Roster, Team
from app.transactions import build_ownership_timelines, owner_on_date

CATS = ("points", "rebounds", "assists", "steals", "blocks")
CURRENT_SEASON = 2026
FULL_SEASON_GAMES = 44  # WNBA regular season length; revisit if league changes


@dataclass(frozen=True)
class PlayerContribution:
    player_id: int
    name: str
    positions: tuple[str, ...]
    wnba_team: str | None
    is_rookie: bool
    games: int
    points: int
    rebounds: int
    assists: int
    steals: int
    blocks: int
    injury_status: str | None
    is_current_roster: bool   # False = traded-away player whose pre-trade
                              # stats still attribute to this team via the
                              # ownership timeline. UI usually marks these
                              # with a strikethrough or "departed" label.


@dataclass(frozen=True)
class CatLine:
    total: int
    rank: float          # tie-aware (e.g. 1.5 for two teams tied for 1st-2nd)
    projected: int       # extrapolation to full season — see _project_total


@dataclass(frozen=True)
class TeamStanding:
    team_id: int
    team_name: str
    is_my_team: bool
    draft_slot: int
    games_played: int    # max GP across this team's roster (rough "weeks elapsed")
    rank_sum: float      # sum of 5 cat ranks; lower = better
    standing: float      # 1..N tie-aware overall place
    cats: dict[str, CatLine]
    players: list[PlayerContribution]


@dataclass(frozen=True)
class StandingsResult:
    season: int
    league_games_to_date: int   # max GP across ALL players in DB (projection denominator)
    full_season_games: int
    teams: list[TeamStanding]
    computed_at: datetime


def _rank_with_ties(values_by_id: dict[int, float]) -> dict[int, float]:
    """Return tie-aware ranks (highest value = rank 1).

    Ties share the average of their consecutive positions. Empty input
    returns an empty dict — caller decides what to do."""
    if not values_by_id:
        return {}
    items = sorted(values_by_id.items(), key=lambda kv: kv[1], reverse=True)
    ranks: dict[int, float] = {}
    i = 0
    n = len(items)
    while i < n:
        j = i
        while j < n and items[j][1] == items[i][1]:
            j += 1
        avg_rank = (i + 1 + j) / 2
        for k in range(i, j):
            ranks[items[k][0]] = avg_rank
        i = j
    return ranks


def _project_total(current: int, team_games: int, full_season: int) -> int:
    """Linear-pace extrapolation to a full season.

    Pre-season (team_games=0) returns 0 — the UI shows '—' rather than 0
    based on `league_games_to_date == 0`. Once the season has started we
    use *team-level* games elapsed, not global, so a team whose roster
    has played fewer games (e.g. early-season slate gaps) projects from
    its own pace rather than getting penalized by a luckier team's
    earlier start."""
    if team_games <= 0:
        return 0
    return round(current * full_season / team_games)


def _games_played_per_player(db: Session, season: int) -> dict[int, int]:
    """player_id -> count of game_stats rows for the season."""
    counts: dict[int, int] = {}
    for g in db.scalars(select(GameStats).where(GameStats.season == season)).all():
        counts[g.player_id] = counts.get(g.player_id, 0) + 1
    return counts


def aggregate_team_totals(
    db: Session,
    team_player_map: dict[int, set[int]],
    season: int = CURRENT_SEASON,
) -> dict[int, dict[str, int]]:
    """Sum the 5 cats across the given player set per team.

    Designed for reuse by the CP11 transaction simulator: pass mocked
    {team_id: {player_ids}} maps representing post-swap rosters and get
    back the same cat totals shape."""
    if not team_player_map:
        return {}
    all_player_ids: set[int] = set().union(*team_player_map.values())
    if not all_player_ids:
        return {tid: {c: 0 for c in CATS} for tid in team_player_map}

    per_player: dict[int, dict[str, int]] = {pid: {c: 0 for c in CATS} for pid in all_player_ids}
    rows = db.scalars(
        select(GameStats).where(
            GameStats.season == season,
            GameStats.player_id.in_(all_player_ids),
        )
    ).all()
    for g in rows:
        bucket = per_player[g.player_id]
        for c in CATS:
            bucket[c] += getattr(g, c)

    out: dict[int, dict[str, int]] = {}
    for tid, pids in team_player_map.items():
        totals = {c: 0 for c in CATS}
        for pid in pids:
            for c in CATS:
                totals[c] += per_player.get(pid, {}).get(c, 0)
        out[tid] = totals
    return out


def compute_standings(
    db: Session,
    season: int = CURRENT_SEASON,
) -> StandingsResult:
    teams = list(
        db.scalars(
            select(Team).where(Team.is_active.is_(True)).order_by(Team.draft_slot)
        ).all()
    )
    if not teams:
        return StandingsResult(
            season=season,
            league_games_to_date=0,
            full_season_games=FULL_SEASON_GAMES,
            teams=[],
            computed_at=datetime.now(timezone.utc),
        )

    rosters = list(db.scalars(select(Roster)).all())
    rosters_by_team: dict[int, list[Roster]] = {t.id: [] for t in teams}
    for r in rosters:
        rosters_by_team.setdefault(r.team_id, []).append(r)

    players = {p.id: p for p in db.scalars(select(Player)).all()}
    injuries = {
        i.player_id: i
        for i in db.scalars(select(Injury).where(Injury.player_id.is_not(None))).all()
    }
    games_by_player_id: dict[int, list[GameStats]] = {}
    for g in db.scalars(select(GameStats).where(GameStats.season == season)).all():
        games_by_player_id.setdefault(g.player_id, []).append(g)

    league_games_to_date = max(
        (len(v) for v in games_by_player_id.values()),
        default=0,
    )

    # Ownership timelines: for each player who has any transaction history,
    # we attribute each game's stats to whichever team owned the player on
    # that date. Without backdating this collapses to "current owner". With
    # backdating (CP9), it splits a player's contributions across owners
    # exactly the way the league sheet would.
    timelines = build_ownership_timelines(db)

    # Pass 1: per-team totals + per-player contributions per OWNERSHIP-AT-GAME-DATE
    team_totals: dict[int, dict[str, int]] = {t.id: {c: 0 for c in CATS} for t in teams}
    team_team_games: dict[int, int] = {t.id: 0 for t in teams}
    # team_id -> player_id -> {cat: int, games: int}
    contribs_buckets: dict[int, dict[int, dict[str, int]]] = {t.id: {} for t in teams}
    for player_id, pgames in games_by_player_id.items():
        windows = timelines.get(player_id, [])
        if not windows:
            continue
        for g in pgames:
            owner = owner_on_date(windows, g.game_date)
            if owner is None or owner not in team_totals:
                continue
            for c in CATS:
                team_totals[owner][c] += getattr(g, c)
            bucket = contribs_buckets[owner].setdefault(
                player_id, {"games": 0, **{c: 0 for c in CATS}}
            )
            bucket["games"] += 1
            for c in CATS:
                bucket[c] += getattr(g, c)
            team_team_games[owner] = max(team_team_games[owner], bucket["games"])

    # Build {team_id: set of player_ids ever owned} from the ownership timelines,
    # so we can surface dropped players who left a footprint here even when
    # their tenure produced 0 games (e.g. an injured player held + then
    # dropped before they ever played). Without this, "drop-with-0-games"
    # transactions vanish from the team panel and the trade looks invisible.
    team_ever_owned: dict[int, set[int]] = {t.id: set() for t in teams}
    for pid, windows in timelines.items():
        for w in windows:
            if w.team_id in team_ever_owned:
                team_ever_owned[w.team_id].add(pid)

    # Pass 1b: build PlayerContribution rows. Each team gets:
    #   - All current rostered players (with stats from their tenure here, or 0s)
    #   - Any "departed" player who EVER had an ownership window on this
    #     team — even with 0 contributed games — so a drop is always visible
    #     in the roster view, matching the way the league sheet records it.
    team_contribs: dict[int, list[PlayerContribution]] = {}
    for t in teams:
        current_pids = {r.player_id for r in rosters_by_team[t.id]}
        all_pids = current_pids | team_ever_owned[t.id]
        contribs: list[PlayerContribution] = []
        for pid in all_pids:
            p = players.get(pid)
            if p is None:
                continue
            bucket = contribs_buckets[t.id].get(pid, {"games": 0, **{c: 0 for c in CATS}})
            inj = injuries.get(p.id)
            contribs.append(PlayerContribution(
                player_id=p.id,
                name=p.name,
                positions=tuple(p.positions or []),
                wnba_team=p.wnba_team,
                is_rookie=p.is_rookie,
                games=bucket["games"],
                points=bucket["points"],
                rebounds=bucket["rebounds"],
                assists=bucket["assists"],
                steals=bucket["steals"],
                blocks=bucket["blocks"],
                injury_status=inj.status if inj else None,
                is_current_roster=pid in current_pids,
            ))
        # Sort: current first, then departed; within each, by points desc.
        contribs.sort(key=lambda c: (not c.is_current_roster, -c.points, c.name))
        team_contribs[t.id] = contribs

    # Pass 2: per-cat ranks across teams
    cat_ranks: dict[str, dict[int, float]] = {}
    for c in CATS:
        cat_ranks[c] = _rank_with_ties(
            {tid: float(totals[c]) for tid, totals in team_totals.items()}
        )

    # Pass 3: rank-sum + overall standing (lower rank-sum = better -> invert for tie-aware sorter)
    rank_sums: dict[int, float] = {
        tid: sum(cat_ranks[c][tid] for c in CATS) for tid in team_totals
    }
    # _rank_with_ties expects "higher = better", so feed -rank_sum.
    standings_by_team = _rank_with_ties({tid: -rs for tid, rs in rank_sums.items()})

    # Build output
    out_teams: list[TeamStanding] = []
    for t in teams:
        totals = team_totals[t.id]
        team_games = team_team_games[t.id]
        cats = {
            c: CatLine(
                total=totals[c],
                rank=cat_ranks[c][t.id],
                projected=_project_total(totals[c], team_games, FULL_SEASON_GAMES),
            )
            for c in CATS
        }
        out_teams.append(TeamStanding(
            team_id=t.id,
            team_name=t.name,
            is_my_team=t.is_my_team,
            draft_slot=t.draft_slot,
            games_played=team_games,
            rank_sum=rank_sums[t.id],
            standing=standings_by_team[t.id],
            cats=cats,
            players=team_contribs[t.id],
        ))
    out_teams.sort(key=lambda x: (x.standing, x.rank_sum, x.team_name))

    return StandingsResult(
        season=season,
        league_games_to_date=league_games_to_date,
        full_season_games=FULL_SEASON_GAMES,
        teams=out_teams,
        computed_at=datetime.now(timezone.utc),
    )
