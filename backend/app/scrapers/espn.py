"""ESPN scrapers: team rosters (for ESPN player IDs) and injuries page.

Why team rosters: ESPN doesn't expose a /wnba/players index (404), and
we need ESPN IDs as the canonical cross-source key (per CP2 plan). One
fetch per team (~15 teams) + one fetch for injuries.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

from bs4 import BeautifulSoup

from app.scrapers.base import RateLimitedSession

TEAMS_INDEX_URL = "https://www.espn.com/wnba/teams"
ROSTER_URL = "https://www.espn.com/wnba/team/roster/_/name/{slug}"
INJURIES_URL = "https://www.espn.com/wnba/injuries"

_PLAYER_HREF_RE = re.compile(r"/wnba/player/_/id/(\d+)/([\w-]+)")


@dataclass(frozen=True)
class EspnPlayer:
    espn_id: str
    name: str
    team_slug: str  # ESPN's slug (e.g., "lv", "ny")


@dataclass(frozen=True)
class EspnInjury:
    espn_id: str
    name: str
    status: str  # "Day-To-Day" | "Out" | "Out For Season" | "Questionable" | ...
    return_date_raw: str  # "Apr 30", "May 8", etc. — kept raw for transparency
    return_date: date | None  # parsed if possible
    description: str


def fetch_team_slugs(session: RateLimitedSession) -> list[str]:
    r = session.get(TEAMS_INDEX_URL)
    r.raise_for_status()
    slugs = sorted(set(re.findall(r'/wnba/team/roster/_/name/([a-z0-9]+)', r.text)))
    if not slugs:
        raise RuntimeError("ESPN teams index: no roster slugs found")
    return slugs


def _parse_roster(html: str, slug: str) -> list[EspnPlayer]:
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    players: list[EspnPlayer] = []
    for a in soup.find_all("a", href=_PLAYER_HREF_RE):
        m = _PLAYER_HREF_RE.search(a.get("href", ""))
        if not m:
            continue
        espn_id = m.group(1)
        if espn_id in seen:
            continue
        name = a.get_text(strip=True)
        if not name:
            continue
        seen.add(espn_id)
        players.append(EspnPlayer(espn_id=espn_id, name=name, team_slug=slug))
    return players


def fetch_player_index(session: RateLimitedSession | None = None) -> list[EspnPlayer]:
    """Walk every team roster and collect (espn_id, name, team_slug) tuples."""
    sess = session or RateLimitedSession()
    slugs = fetch_team_slugs(sess)
    all_players: list[EspnPlayer] = []
    for slug in slugs:
        r = sess.get(ROSTER_URL.format(slug=slug))
        if not r.ok:
            # log, but keep going — one team failing shouldn't kill the whole pass
            continue
        all_players.extend(_parse_roster(r.text, slug))
    return all_players


def _parse_return_date(raw: str, today: date | None = None) -> date | None:
    """ESPN shows dates like 'Apr 30', 'May 8' (no year). Pick the next
    occurrence on or after `today` so a stale 'Mar 15' doesn't get parsed
    into the past during a refresh."""
    raw = (raw or "").strip()
    if not raw or raw.lower() in ("--", "tbd", "n/a"):
        return None
    today = today or date.today()
    for fmt in ("%b %d", "%B %d"):
        try:
            parsed = datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
        candidate = parsed.replace(year=today.year)
        if candidate < today:
            candidate = candidate.replace(year=today.year + 1)
        return candidate
    return None


def fetch_injuries(session: RateLimitedSession | None = None) -> list[EspnInjury]:
    sess = session or RateLimitedSession()
    r = sess.get(INJURIES_URL)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    out: list[EspnInjury] = []
    seen: set[str] = set()
    for table in soup.find_all("table"):
        for tr in table.select("tbody tr"):
            a = tr.find("a", href=_PLAYER_HREF_RE)
            if not a:
                continue
            m = _PLAYER_HREF_RE.search(a.get("href", ""))
            if not m:
                continue
            espn_id = m.group(1)
            if espn_id in seen:
                continue
            cells = [c.get_text(strip=True) for c in tr.find_all(["td", "th"])]
            # Observed shape: [name, pos, est_return, status, comment]
            if len(cells) < 5:
                continue
            name = a.get_text(strip=True)
            return_raw = cells[2]
            status = cells[3]
            description = cells[4]
            seen.add(espn_id)
            out.append(EspnInjury(
                espn_id=espn_id,
                name=name,
                status=status,
                return_date_raw=return_raw,
                return_date=_parse_return_date(return_raw),
                description=description,
            ))
    return out
