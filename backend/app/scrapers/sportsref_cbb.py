"""sports-reference.com Women's CBB scraper.

For projecting WNBA rookies, we need their final college season's per-40
production. Sports-reference exposes this at:

    /cbb/players/<slug>.html

with `<table id="players_per_min">` (Per-40-Minutes). Slugs look like
`firstname-lastname-N` where N disambiguates same-name players. Both
men's and women's players share the slug namespace, so we filter to
women's-CBB rows by checking that the team-link href contains `/women/`.

Slug discovery uses the site search:
    /cbb/search/search.fcgi?search=<urlencoded name>

The search redirects to the player page on a unique match, or returns a
results page (which we parse to pick the right entry) on a collision.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from app.scrapers.base import RateLimitedSession

SEARCH_URL = "https://www.sports-reference.com/cbb/search/search.fcgi?search={q}"
PLAYER_URL = "https://www.sports-reference.com{path}"

_PLAYER_PATH_RE = re.compile(r"^/cbb/players/[a-z0-9-]+\.html$")
_SCHOOL_YEAR_RE = re.compile(r"/cbb/schools/([a-z0-9-]+)/women/(\d{4})\.html")
_SEARCH_YEAR_RANGE_RE = re.compile(r"\((\d{4})-(\d{4})\)")


@dataclass(frozen=True)
class CbbSeasonStats:
    """Per-40-minute stats for a single college season.

    All cat fields are per-40 (per-40-minutes), matching sports-reference's
    `players_per_min` table. Games and minutes are absolute totals.
    """
    slug: str
    season: int  # season-end year, e.g., 2026 for the 2025-26 season
    school: str  # SR school slug, e.g. "connecticut", "ucla"
    games: int
    minutes: int
    pts_per_40: float
    trb_per_40: float
    ast_per_40: float
    stl_per_40: float
    blk_per_40: float


def _resolve_slug_path(html: str, final_url: str, school_hint: str | None) -> str | None:
    """If `final_url` is already a player page, return its path. Otherwise
    parse the search-results page and pick the best match.

    `school_hint` is optional — used to disambiguate when multiple
    same-name women's players exist. Falls back to "year range ends most
    recently" if no school match.
    """
    m = re.search(r"/cbb/players/[a-z0-9-]+\.html", final_url)
    if m:
        return m.group(0)

    soup = BeautifulSoup(html, "html.parser")
    candidates: list[tuple[int, int, str, str]] = []  # (matches_school, year_to, path, team_text)
    norm_hint = (school_hint or "").lower().strip()
    for item in soup.select("div.search-item"):
        a = item.select_one("div.search-item-name a")
        team_div = item.select_one("div.search-item-team")
        if not a or not team_div:
            continue
        href = a.get("href", "")
        path_m = _PLAYER_PATH_RE.match(href)
        if not path_m:
            continue
        team_text = team_div.get_text(" ", strip=True)
        if "(Women)" not in team_text:
            continue  # men's player with same name; skip
        # Year range like "(2022-2026)" lives on the name line.
        name_text = a.parent.get_text(" ", strip=True) if a.parent else ""
        yr = _SEARCH_YEAR_RANGE_RE.search(name_text)
        year_to = int(yr.group(2)) if yr else 0
        school_match = 1 if norm_hint and norm_hint in team_text.lower() else 0
        candidates.append((school_match, year_to, href, team_text))

    if not candidates:
        return None
    # Best: school match wins; tiebreak by latest year_to.
    candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
    return candidates[0][2]


def find_player_slug(
    name: str,
    school_hint: str | None,
    session: RateLimitedSession,
) -> str | None:
    """Resolve a player name (+ optional school hint) to a sports-reference
    player path like `/cbb/players/azzi-fudd-1.html`. Returns None if no
    women's CBB match found."""
    r = session.get(SEARCH_URL.format(q=quote_plus(name)))
    if not r.ok:
        return None
    return _resolve_slug_path(r.text, r.url, school_hint)


def _cell_text(td) -> str:
    """Extract a table cell's plain text, peeling off <strong>/<a> wrappers."""
    if td is None:
        return ""
    return td.get_text(strip=True)


def _to_int(v: str) -> int:
    if not v:
        return 0
    try:
        return int(float(v))
    except ValueError:
        return 0


def _to_float(v: str) -> float:
    if not v:
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def _strip_sr_comment_wrappers(html: str) -> str:
    """sports-reference wraps secondary stat tables (per-40, per-100, advanced)
    inside HTML comments to defeat ad-blockers. BS4 happily skips commented
    content, so we strip `<!--` / `-->` pairs so the wrapped tables become
    visible to the parser. The page's first comment is the doctype header
    boilerplate which is also fine to expose."""
    return html.replace("<!--", "").replace("-->", "")


def parse_per_min_table(html: str, slug: str) -> list[CbbSeasonStats]:
    """Extract all women's-CBB per-40 rows from a player page.

    Filters to rows whose team link goes to `/cbb/schools/<school>/women/<year>.html`
    (i.e., women's CBB seasons only — same slug can host a men's player
    or, theoretically, mixed). Skips the Career summary row.
    """
    soup = BeautifulSoup(_strip_sr_comment_wrappers(html), "html.parser")
    table = soup.find("table", id="players_per_min")
    if table is None:
        return []
    out: list[CbbSeasonStats] = []
    for tr in table.select("tbody tr"):
        # Class-summary "Career" row has no team link.
        team_cell = tr.find("td", attrs={"data-stat": "team_name_abbr"})
        if team_cell is None:
            continue
        a = team_cell.find("a")
        if a is None:
            continue
        m = _SCHOOL_YEAR_RE.search(a.get("href", ""))
        if not m:
            continue
        school, season = m.group(1), int(m.group(2))

        def cell(stat: str) -> str:
            td = tr.find("td", attrs={"data-stat": stat})
            return _cell_text(td)

        out.append(CbbSeasonStats(
            slug=slug,
            season=season,
            school=school,
            games=_to_int(cell("games")),
            minutes=_to_int(cell("mp")),
            pts_per_40=_to_float(cell("pts_per_min")),
            trb_per_40=_to_float(cell("trb_per_min")),
            ast_per_40=_to_float(cell("ast_per_min")),
            stl_per_40=_to_float(cell("stl_per_min")),
            blk_per_40=_to_float(cell("blk_per_min")),
        ))
    return out


def fetch_player_seasons(
    slug_path: str,
    session: RateLimitedSession,
) -> list[CbbSeasonStats]:
    """Given a path like '/cbb/players/azzi-fudd-1.html', return all
    women's-CBB seasons in per-40 form (most-recent last)."""
    r = session.get(PLAYER_URL.format(path=slug_path))
    r.raise_for_status()
    slug = slug_path.rsplit("/", 1)[-1].removesuffix(".html")
    seasons = parse_per_min_table(r.text, slug)
    seasons.sort(key=lambda s: s.season)
    return seasons


def latest_season(seasons: list[CbbSeasonStats]) -> CbbSeasonStats | None:
    """Pick the row to project from: most recent season with games >= 5.

    Filters out tiny-sample injury/redshirt years (Fudd's JR row was 2 games
    after a knee tear — not what we want to project from). Falls back to
    the most recent row of any size if none clear the threshold."""
    if not seasons:
        return None
    big = [s for s in seasons if s.games >= 5]
    pool = big or seasons
    return max(pool, key=lambda s: s.season)
