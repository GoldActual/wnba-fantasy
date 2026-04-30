"""WNBA.com /players scraper.

The /players page embeds the full current-season player list in
__NEXT_DATA__ as positional tuples — one fetch returns everything we need
(WNBA player ID, name, team, and *position with dual-eligibility*).

Position values in this source are single letters or hyphenated pairs:
"G", "F", "C", "F-G", "G-F", "C-F", "F-C". We split on hyphen and store
as a JSON list (e.g. "F-G" -> ["F", "G"]).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.scrapers.base import RateLimitedSession

PLAYERS_URL = "https://www.wnba.com/players"

# Positional-tuple indices in __NEXT_DATA__.props.pageProps.currentPlayersData[i]:
_IDX_WNBA_ID = 0
_IDX_LAST = 1
_IDX_FIRST = 2
_IDX_TEAM_ABBR = 8
_IDX_POSITION = 10


@dataclass(frozen=True)
class WnbaPlayer:
    wnba_id: int
    name: str  # "A'ja Wilson"
    positions: list[str]  # ["F", "G"]
    wnba_team: str | None  # "PHX"


def parse_positions(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [p.strip() for p in raw.split("-") if p.strip()]


def fetch_current_players(session: RateLimitedSession | None = None) -> list[WnbaPlayer]:
    sess = session or RateLimitedSession()
    r = sess.get(PLAYERS_URL)
    r.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
    if not m:
        raise RuntimeError("WNBA.com /players: __NEXT_DATA__ tag not found (page structure changed?)")
    payload = json.loads(m.group(1))
    rows = payload["props"]["pageProps"]["currentPlayersData"]

    players: list[WnbaPlayer] = []
    for row in rows:
        wnba_id = row[_IDX_WNBA_ID]
        first = row[_IDX_FIRST] or ""
        last = row[_IDX_LAST] or ""
        name = f"{first} {last}".strip()
        if not name or wnba_id is None:
            continue
        players.append(WnbaPlayer(
            wnba_id=int(wnba_id),
            name=name,
            positions=parse_positions(row[_IDX_POSITION]),
            wnba_team=row[_IDX_TEAM_ABBR] or None,
        ))
    return players
