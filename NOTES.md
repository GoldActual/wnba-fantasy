# NOTES — WNBA Fantasy Tracker

Running log of decisions and known issues. Append-only-ish: prefer adding new entries over rewriting old ones, so future-me has the trail.

---

## 2026-04-29 — Checkpoint 1: Project scaffold

### Stack choices
- **Backend:** Python 3.11, FastAPI, SQLAlchemy 2.0 (sync), SQLite. Sync is fine — single user, single machine.
- **Frontend:** React + TypeScript, Vite, Tailwind v4 via the `@tailwindcss/vite` plugin (no `postcss.config.js`, no `tailwind.config.js` — v4 is config-by-CSS).
- **Scrapers:** `requests` + `beautifulsoup4`. Reach for Playwright only if a target is genuinely JS-only after we inspect the network tab.

### Schema decisions
- `players.positions` is a JSON list of single-letter codes (`["G"]`, `["F","G"]`, `["C","F"]`). Roster slot eligibility = set intersection. Utility accepts anyone.
- `players.is_rookie` + `players.stats_source` (`'wnba_actual' | 'ncaa_projection'`) are present from day 1 so we can flip rookies to actual stats mid-season (Phase 2) without a migration.
- `rosters` is the **current ownership** view (one row per drafted player, UNIQUE on `player_id`) — fast path for the draft UI.
- `transactions` is the **source of truth** for ownership history, with `effective_date`. Phase 2 stat attribution joins stats to whichever team owned a player on the stat's date. Even Phase 1 draft picks insert a `transaction_type='draft'` row, so the audit trail is complete from day 1.
- `transactions.transaction_type='team_dissolved'` is reserved for Phase 2 — when a team drops out mid-season, their roster dissolves into FA on that effective date.
- `injuries` is a **snapshot table**: refresh = upsert by `espn_player_id`. Doesn't accumulate history (don't need it for Phase 1).
- `stats_seasons` UNIQUE on (`player_id`, `season`, `source`). Same player can have a `ncaa_projection` row and a `wnba_actual` row for the same season — that's how Phase 2 will swap a rookie's projected stats for real ones.
- No Alembic for Phase 1. Greenfield, 3 days to draft. Migrations come in Phase 2 once the schema settles.

### Dev wiring
- Vite dev server proxies `/api/*` to `http://localhost:8000` — frontend code just calls `/api/health`, no CORS-in-dev headache.
- FastAPI also has CORS middleware for `localhost:5173` and `localhost:8000` so direct API calls work from anywhere on the dev box.
- LAN/phone access (binding to `0.0.0.0`, allowing the LAN IP) is **deferred to Checkpoint 6**.

### Open questions deferred to later checkpoints
- **CP2:** Rotowire `stats.php` JSON endpoint — must be discovered via browser network tab. Fall back to Basketball Reference if not feasible.
- **CP3:** Translation factors for NCAA per-36 → WNBA per-36. PLAN.md starting values (PTS 0.55, REB 0.70, AST 0.60, STL 0.50, BLK 0.50) live in a config file once we get there. Backtest is Phase 2.
- **CP3:** MPG estimation buckets by draft pick (PLAN.md has the buckets).
- **CP4:** Z-score baseline — mean across all rostered-eligible players, or top-N? Default to all players in the DB; revisit if rankings look off.
- **CP5:** Live category-strength projection math.

### Known issues
- None yet.

---

## 2026-04-29 — Checkpoint 2: Veteran data ingestion

### Sources confirmed
- **Stats (2024 + 2025):** Rotowire's table loader hits `https://www.rotowire.com/wnba/tables/stats.php?statType=total&season=YYYY` — clean JSON, all 5 cats + games + minutes. Discovered by searching the inline JS on `/wnba/stats.php`. Requires `Referer` + `X-Requested-With: XMLHttpRequest` headers to mimic the in-page fetch.
- **Positions (with dual-eligibility):** WNBA.com `/players` page embeds the entire current-season player list (272 players) inside `__NEXT_DATA__` as positional 25-tuples. **One fetch** vs the ~200-page-per-player scrape we feared. Position field is at index 10, format like `"G"`, `"F-G"`, `"C-F"` — split on hyphen → JSON list.
- **ESPN player IDs:** ESPN's `/wnba/players` index is 404. Iterate 15 team rosters from `/wnba/teams`. Slugs are extracted dynamically so expansion teams get picked up automatically. ~45 sec to scrape all 15.
- **Injuries:** `/wnba/injuries` is static HTML, BS4 parses it cleanly. 24 current entries, all linked to players via ESPN ID.

### Source quirks (worth remembering)
- **Rotowire emits one row per (player, team)**, not per-player. Players traded mid-season get two rows that we have to **sum** to get a season total. 7 such players in 2024, 21 in 2025. The aggregate-sum logic is in `upsert_season_totals()`.
- **Rotowire upstream typo:** `asists` (no second `s`) instead of `assists`. Mapped at parse time.
- **Rotowire encoding bug:** Azurá Stevens shows up as `Azur&#2013265921; Stevens` (invalid HTML numeric entity, codepoint > U+10FFFF). Manual alias map in `app/scrapers/rotowire.py::_NAME_FIXES`. Add new entries here as they appear.
- **Rotowire doubles apostrophes:** `A''ja Wilson` (two single quotes). `normalize_name` strips all punctuation, so this collapses correctly during matching — no special handling needed.
- **Rotowire `Phoenix` abbr is `PHO`**, WNBA.com uses `PHX`. We don't try to canonicalize team abbreviations across sources; we just store WNBA.com's value.
- **Team coverage:** 2024 = 12 teams, 2025 added GSV (Golden State Valkyries) = 13, 2026 has 15 teams (added TOR Tempo + PDX Portland) — schema is dynamic, not hardcoded.

### Cross-source matching
- Canonical key = ESPN ID (per CP2 user choice). Set on a player record when ESPN team-roster scrape finds a name match.
- Match function: `app/matching.py::normalize_name` — lowercase, NFKD-strip diacritics, drop punctuation, collapse whitespace, drop Jr/Sr/II/III suffixes.
- Duplicate normalized names in WNBA.com data: 0 currently. If two players ever share a normalized name, the warning appears in the refresh output; resolve by adding context (team, jersey) to the key.

### Match coverage at first run (2026-04-29)
- 272 players from WNBA.com
- 268/272 (99%) ESPN ID coverage — 4 unmatched are WNBA.com training-camp invitees not yet on official rosters
- 11 ESPN players unmatched (training-camp slots not on WNBA.com's roster yet — fine, we don't need them)
- 116/164 unique 2024 Rotowire players matched (48 unmatched are retired/unsigned vets like Tina Charles, Diana Taurasi)
- 151/187 unique 2025 Rotowire players matched (36 unmatched, same pattern)
- 24/24 injuries linked to players (100%)

### Refresh script behavior
- `python scripts/refresh.py` runs all four scrapers in order. Idempotent: re-running UPDATEs existing rows rather than duplicating.
- **Never touches** `teams`, `rosters`, or `transactions` (per PLAN.md gotcha).
- Stale injury rows (player no longer on ESPN's report) are deleted — injuries are a snapshot, not history.
- Total scrape time: ~75 sec (15 ESPN rosters × 3 sec + 4 other fetches × 3 sec).
