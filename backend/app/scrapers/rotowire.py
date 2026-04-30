"""Rotowire WNBA season-totals scraper.

The /wnba/stats.php page is JS-rendered, but the table loader hits a JSON
endpoint at /wnba/tables/stats.php (visible in inline JS). That endpoint
returns a flat list of dicts — one per player — with fields like:

    PlayerID, player, team, position, games, minutes,
    pts, reb, asists (sic), steals, blocks, ...

Note: 'asists' is misspelled in the upstream source. We map it to
'assists' on our side.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.scrapers.base import RateLimitedSession

ENDPOINT = "https://www.rotowire.com/wnba/tables/stats.php?statType=total&season={season}"
REFERER = "https://www.rotowire.com/wnba/stats.php?statType=total&season={season}"

# Manual fixes for known upstream encoding bugs in Rotowire's player field.
# Their encoder occasionally emits invalid HTML numeric character references
# (e.g. &#2013265921;) in place of accented letters. Map verbatim string ->
# canonical WNBA.com display name. Add entries here as they appear.
_NAME_FIXES = {
    "Azur&#2013265921; Stevens": "Azurá Stevens",
}


@dataclass(frozen=True)
class RotowireSeasonTotals:
    rotowire_id: str
    name: str  # raw Rotowire display name (apostrophes may be doubled)
    team: str | None
    season: int
    games_played: int
    minutes: float
    points: int
    rebounds: int
    assists: int
    steals: int
    blocks: int


def _to_int(v) -> int:
    if v is None or v == "":
        return 0
    return int(float(v))


def _to_float(v) -> float:
    if v is None or v == "":
        return 0.0
    return float(v)


def fetch_season_totals(season: int, session: RateLimitedSession | None = None) -> list[RotowireSeasonTotals]:
    sess = session or RateLimitedSession()
    r = sess.get(
        ENDPOINT.format(season=season),
        headers={
            "X-Requested-With": "XMLHttpRequest",
            "Referer": REFERER.format(season=season),
        },
    )
    r.raise_for_status()
    rows = r.json()

    out: list[RotowireSeasonTotals] = []
    for row in rows:
        raw_name = row.get("player", "")
        name = _NAME_FIXES.get(raw_name, raw_name)
        out.append(RotowireSeasonTotals(
            rotowire_id=str(row.get("PlayerID", "")),
            name=name,
            team=row.get("team") or None,
            season=season,
            games_played=_to_int(row.get("games")),
            minutes=_to_float(row.get("minutes")),
            points=_to_int(row.get("pts")),
            rebounds=_to_int(row.get("reb")),
            # Rotowire upstream typo: 'asists'
            assists=_to_int(row.get("asists") or row.get("assists")),
            steals=_to_int(row.get("steals")),
            blocks=_to_int(row.get("blocks")),
        ))
    return out
