"""Basketball-Reference WNBA per-game scraper.

Two endpoints:
  - Season totals (`/wnba/years/{season}_totals.html`): table id `totals`.
    Used to discover (name, slug) pairs once per season — slugs feed the
    gamelog URL.
  - Player gamelog (`/wnba/players/{first}/{slug}/gamelog/{season}/`):
    table id `wnba_pgl_basic` (regular season; playoffs are `_p` variant).

BBR quirks:
  - Secondary tables can be wrapped in HTML comments as an ad-blocker
    workaround (same trick as sports-reference's CBB pages — see
    sportsref_cbb._strip_sr_comment_wrappers). The gamelog table
    `wnba_pgl_basic` is wrapped this way; the totals table is not. Strip
    `<!--` / `-->` from the raw HTML before parsing to be safe.
  - Inactive / DNP rows have a non-numeric `mp` cell ("Did Not Play",
    "Inactive", or empty). We skip those — no stats to record.
  - Default User-Agent gets 403'd; the existing RateLimitedSession UA
    ("WNBAFantasyTracker/0.1 ...") is accepted.
  - Requires the 3-second rate limit to avoid temporary blocks. Per
    SCRAPE_MIN_INTERVAL_SECONDS in app.config.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from bs4 import BeautifulSoup

from app.scrapers.base import RateLimitedSession

SEASON_TOTALS_URL = "https://www.basketball-reference.com/wnba/years/{season}_totals.html"
PLAYER_GAMELOG_URL = (
    "https://www.basketball-reference.com/wnba/players/{first}/{slug}/gamelog/{season}/"
)

_SLUG_RE = re.compile(r"^/wnba/players/([a-z])/([a-z0-9]+)\.html$")


@dataclass(frozen=True)
class BbrPlayerEntry:
    slug: str
    name: str
    team: str | None


@dataclass(frozen=True)
class BbrGame:
    game_date: date
    team: str | None
    opponent: str | None
    is_home: bool
    started: bool
    minutes: float
    points: int
    rebounds: int
    assists: int
    steals: int
    blocks: int


def _strip_comments(html: str) -> str:
    return re.sub(r"<!--|-->", "", html)


def _parse_minutes(mp: str | None) -> float:
    """'35:46' -> 35.77 (decimal minutes). Empty / non-MM:SS -> 0.0."""
    if not mp or ":" not in mp:
        return 0.0
    try:
        m, s = mp.split(":")
        return int(m) + int(s) / 60.0
    except (ValueError, TypeError):
        return 0.0


def _to_int(s: str | None) -> int:
    if not s:
        return 0
    try:
        return int(s)
    except ValueError:
        return 0


def fetch_player_index(
    season: int,
    session: RateLimitedSession | None = None,
) -> list[BbrPlayerEntry]:
    """Scrape the season totals page; return (slug, name, team) for every player.

    Players who appeared on multiple teams in a season have one TOT row
    plus per-team rows — we keep only the first occurrence of each slug
    (TOT comes first), so `team` is 'TOT' for traded players. That's fine
    for slug discovery; we don't use the team column from this source."""
    sess = session or RateLimitedSession()
    r = sess.get(SEASON_TOTALS_URL.format(season=season))
    r.raise_for_status()
    soup = BeautifulSoup(_strip_comments(r.text), "html.parser")
    table = soup.find("table", id="totals")
    if table is None:
        return []
    tbody = table.find("tbody")
    if tbody is None:
        return []

    seen: set[str] = set()
    out: list[BbrPlayerEntry] = []
    for row in tbody.find_all("tr"):
        cls = row.get("class") or []
        if any(c.startswith("thead") for c in cls):
            continue
        link = row.find("a", href=_SLUG_RE)
        if link is None:
            continue
        m = _SLUG_RE.match(link.get("href", ""))
        if not m:
            continue
        slug = m.group(2)
        if slug in seen:
            continue
        seen.add(slug)
        team_cell = row.find("td", {"data-stat": "team_id"})
        out.append(BbrPlayerEntry(
            slug=slug,
            name=link.get_text(strip=True),
            team=team_cell.get_text(strip=True) if team_cell else None,
        ))
    return out


def fetch_player_gamelog(
    slug: str,
    season: int,
    session: RateLimitedSession | None = None,
) -> list[BbrGame]:
    """Per-player regular-season game log. Skips DNP / inactive rows.

    Returns an empty list if the page 404s (player has no rows for the
    season — e.g. they hadn't debuted yet) or if the gamelog table is
    missing (off-season pages render the player profile without one)."""
    sess = session or RateLimitedSession()
    first = slug[0]
    r = sess.get(PLAYER_GAMELOG_URL.format(first=first, slug=slug, season=season))
    if r.status_code == 404:
        return []
    r.raise_for_status()
    soup = BeautifulSoup(_strip_comments(r.text), "html.parser")
    table = soup.find("table", id="wnba_pgl_basic")
    if table is None:
        return []
    tbody = table.find("tbody")
    if tbody is None:
        return []

    out: list[BbrGame] = []
    for row in tbody.find_all("tr"):
        cls = row.get("class") or []
        if any(c.startswith("thead") for c in cls):
            continue
        cells: dict[str, str] = {}
        for c in row.find_all(["th", "td"]):
            ds = c.get("data-stat")
            if ds:
                cells[ds] = c.get_text(strip=True)
        date_str = cells.get("date_game", "")
        mp = cells.get("mp", "")
        # DNP / inactive — minutes is non-MM:SS or empty. Skip.
        if not date_str or ":" not in mp:
            continue
        try:
            game_date = date.fromisoformat(date_str)
        except ValueError:
            continue
        out.append(BbrGame(
            game_date=game_date,
            team=cells.get("team_id") or None,
            opponent=cells.get("opp_id") or None,
            is_home=(cells.get("game_location", "") != "@"),
            started=(cells.get("gs", "") == "1"),
            minutes=_parse_minutes(mp),
            points=_to_int(cells.get("pts")),
            rebounds=_to_int(cells.get("trb")),
            assists=_to_int(cells.get("ast")),
            steals=_to_int(cells.get("stl")),
            blocks=_to_int(cells.get("blk")),
        ))
    return out
