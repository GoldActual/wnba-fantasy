"""WNBA.com /draft/<year>/board scraper.

Server-side rendered Next.js. The full draft (3 rounds × 15 picks) lives
in __NEXT_DATA__.props.pageProps.draftRounds, with name, college, country,
position, drafted-by team, *and* a `career` block of per-game college
averages (PPG/RPG/APG/SPG/BPG/FG%). The career block is sometimes empty
for international prospects whose stats WNBA.com doesn't track.

One fetch per draft year. Idempotent.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.scrapers.base import RateLimitedSession

BOARD_URL = "https://www.wnba.com/draft/{year}/board"


@dataclass(frozen=True)
class DraftPickCareer:
    """Career college averages as exposed by the WNBA.com draft board.

    These are *career* per-game (not last-season) and may be partially
    populated — e.g. SPG/BPG sometimes blank, all blank for some
    internationals. Empty fields come back as None here.
    """
    ppg: float | None
    rpg: float | None
    apg: float | None
    spg: float | None
    bpg: float | None
    fg_pct: float | None


@dataclass(frozen=True)
class DraftPick:
    pick: int  # 1-based pick number *within* the round
    overall_pick: int  # 1-based overall pick number across the whole draft
    round: int  # 1, 2, or 3
    prospect_id: int
    first_name: str
    last_name: str
    position: str  # "Guard" | "Forward" | "Center" — full word, like WNBA.com
    country: str
    college: str  # college name OR foreign club for internationals
    team_name: str  # "Dallas Wings 2026" — drafted-by team
    career: DraftPickCareer

    @property
    def name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


def _to_float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_draft_board(html: str) -> list[DraftPick]:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("WNBA.com draft board: __NEXT_DATA__ tag not found")
    payload = json.loads(m.group(1))
    rounds = payload["props"]["pageProps"]["draftRounds"]

    picks: list[DraftPick] = []
    overall = 0
    for r in sorted(rounds, key=lambda x: x["round"]):
        round_num = int(r["round"])
        for p in sorted(r["picks"], key=lambda x: x["pick"]):
            overall += 1
            c = p.get("career") or {}
            picks.append(DraftPick(
                pick=int(p["pick"]),
                overall_pick=overall,
                round=round_num,
                prospect_id=int(p["prospectId"]),
                first_name=p.get("firstName") or "",
                last_name=p.get("lastName") or "",
                position=p.get("position") or "",
                country=p.get("country") or "",
                college=p.get("college") or "",
                team_name=p.get("teamName") or "",
                career=DraftPickCareer(
                    ppg=_to_float(c.get("ppg")),
                    rpg=_to_float(c.get("rpg")),
                    apg=_to_float(c.get("apg")),
                    spg=_to_float(c.get("spg")),
                    bpg=_to_float(c.get("bpg")),
                    fg_pct=_to_float(c.get("fg%")),
                ),
            ))
    return picks


def fetch_draft_picks(year: int, session: RateLimitedSession | None = None) -> list[DraftPick]:
    sess = session or RateLimitedSession()
    r = sess.get(BOARD_URL.format(year=year))
    r.raise_for_status()
    return parse_draft_board(r.text)
