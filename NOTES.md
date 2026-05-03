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

---

## 2026-04-30 — Checkpoint 3: Rookie ingestion + projection

### Per-40, not per-36
- Both women's NCAA and the WNBA play 40-minute games (4×10 quarters). PLAN.md said "per-36" — that's an NBA carryover. Switched everything to per-40 internally. The PLAN.md multipliers (PTS 0.55, REB 0.70, AST 0.60, STL 0.50, BLK 0.50) were placeholders so the dimensional change is harmless; they live in `data/projection_config.json` and tune without code changes.

### Sources confirmed
- **WNBA.com `/draft/2026/board`** is server-side rendered Next.js. `__NEXT_DATA__.props.pageProps.draftRounds` carries all 45 picks (3 rounds × 15) with `pick`, `firstName`, `lastName`, `college`, `country`, `position`, `prospectId`, `teamName`, plus a `career` block of college per-game averages. **One fetch.**
- **sports-reference.com NCAA player pages** live at `/cbb/players/<slug>.html` (NOT under `/cbb/women/` — men's and women's CBB share the same player namespace). `<table id="players_per_min">` is the Per-40-Minutes table. We filter rows to women's-CBB by checking the team-link href contains `/women/`.
- **Slug discovery via `/cbb/search/search.fcgi?search=<name>`**: redirects to the player page on a unique match, returns a results page on a collision. We parse the results page and pick the women's-CBB entry whose year-range ends most recently (graduating class).

### Source quirks
- **sports-reference HTML-comment ad-blocker trick:** secondary stat tables (per-40, per-100, advanced) are wrapped in `<!-- ... -->` so default BS4 (`html.parser`) won't see them. `_strip_sr_comment_wrappers()` blanks the comment markers before parsing. Found this when our first parse returned 0 seasons for Fudd despite the HTML being there.
- **WNBA.com career block is patchy:** even for US college picks SPG/BPG sometimes come back as empty strings. For full internationals (Awa Fam Thiam, Iyana Martín Carrión) the entire career block is empty.
- **Career stats are *career averages*, not last-season** — Fudd's career line (14.7 ppg) lags her 2025-26 senior year (17.5 ppg). We use sports-reference *latest season* whenever available; only fall back to draft-JSON career-PG when sports-reference can't find the player.

### Coverage at first run (45 picks)
- 32 via NCAA per-40 (the rigorous path)
- 4 via career-per-game fallback (Nell Angloma, Zee Spearman, Charlisse Dunn, Grace VanSlooten — sports-reference search didn't resolve them)
- 9 zero (all internationals with no NCAA + no career-PG: Awa Fam Thiam, Iyana Martín Carrión, Frieda Bühner, Saffron Shiels, Ines Pitarch-Granel, Kokoro Tanaka, Manuela Puoch, Eszter Ratkai, Kejia Ran)
- Total CP3 add-on time: ~3 minutes (1 draft-board fetch + ~70 sports-reference fetches at the 3-second rate-limit)

### Rookie matching
- We match rookies to existing `players` rows by normalized name (so a signed rookie who already appears on WNBA.com /players doesn't get duplicated). 33/45 picks were already in /players from CP1 — only 12 new rows created.
- Order matters in `refresh.py`: WNBA.com /players (CP1) runs before rookie ingest (CP3) so signed rookies start as veterans, then get reclassified (`is_rookie=True`, `stats_source='ncaa_projection'`). Idempotent on rerun.

### Config files (live in `backend/data/`)
- `projection_config.json` — translation factors, MPG buckets by overall pick (1-4 → 27.5, 5-12 → 21.5, 13-24 → 11.5, 25+ → 4.0), default 36 games, assumed 30 college MPG for the per-game fallback. Auto-written from defaults on first import.
- `rookie_overrides.json` — empty `{}` to start. Per-player override schema documented in `app/rookies.py::_apply_overrides`: optional `mpg`, `games`, `<cat>_mult`, `note`. Applied on every `refresh.py` run; can also re-trigger with no scraping by editing the file and running `scripts/report.py` (no — the overrides re-apply only at ingest time; need refresh).

### Known gaps
- **9 zero-projected internationals** are the biggest hole heading into the draft. Fam Thiam and Iyana are first-round picks that will rank dead-last by value until manually overridden in `rookie_overrides.json`.
- **Career-PG fallback returns 0 for STL/BLK** when the WNBA.com `career` block omits them (common). Affects the 4 PG-fallback picks.
- **Backtest of translation multipliers** is deferred to Phase 2 (per PLAN.md). Current values are PLAN.md defaults.

### Refresh script changes
- `[5/5] Rookies` step added. Runs after injuries; ~3 min wall-clock at the 3-sec rate limit.
- `app/reports.py` now prints a "Top 10 projected rookies" block when any rookies are in the DB.

---

## 2026-04-30 — Checkpoint 4: Value score + Best Available view

### Value formula (`app/value.py`)
- z-score per cat against the league mean (PTS, REB, AST, STL, BLK), summed → raw value.
- Multiply by `min(1, games / 32)` (availability), `1.04` for dual-position eligibility, `1.08` for triple, `0.40` if injury status is `Out` / `Out For Season` (Day-To-Day is NOT penalized — display only), `0.70` rookie confidence discount.
- Population stdev (`pstdev`), so a player at the league mean lands at z=0; a degenerate single-element pool collapses safely to stdev=1.

### Vet basis season selection (the Caitlin Clark fix)
- Initial CP4 default was "use 2025 actuals only". That ranked Clark at #120 and Stewart at #22 because their 2025 games-played was injury-shortened — the availability factor (G/32) crushes the score even when the per-game stats were great.
- Fix: vet basis = **most recent `wnba_actual` season with G >= MIN_HEALTHY_GAMES (=25)**, falling back to the most-recent-of-any-size if none clears the threshold. Clark falls back to 2024 (40 G, 769 PTS, 337 AST → rank #3). Stewart's 2025 was 31 G so it stays on 2025; bumping MIN_HEALTHY_GAMES to 35 would flip her to 2024 if we ever want that, but 25 felt like the right floor for "actual season vs injury noise".
- Rookie basis = `(season=2026, source='ncaa_projection')`. Real `wnba_actual` rows always trump projection (Phase-2 swap-in is automatic).

### Sanity check at first run (consensus expectation per PLAN.md)
- A'ja Wilson #1, Alyssa Thomas #2, Caitlin Clark #3, Aliyah Boston #4, Dearica Hamby #5 — looks like consensus top-5 territory.
- Lauren Betts (UCLA #4 pick) is the top rookie at overall #54 (raw 3.33 × 0.70 confidence = 2.29). Fudd #78, Miles #69. No rookies in top 10 — slightly below the PLAN.md "1-2 elite rookies sprinkled in" expectation, but Betts is comfortably in the early-round draftable tier.
- The 9 zero-projection internationals (Awa Fam Thiam, Iyana, Bühner, etc.) sit at the bottom until manual override.

### API + UI
- `GET /api/players` returns the ranked list with optional filters (`search`, `position` ∈ {G,F,C}, `hide_rookies`, `rookies_only`, `limit`).
- Frontend rewritten as a single-page Best Available view: search box, position tabs, rookie toggle, table with rank / injury dot / 🆕 badge / pos / team / value / 5-cat totals. Rookie rows tinted amber. No draft state yet — that's CP5.

---

## 2026-05-03 — Post-draft data fixes

The draft ran on Saturday May 2. Three picks were filled with random players because of search/availability problems during the draft; corrected today against the user's authoritative CSV (`WNBA Draft 2026 - Sheet1.csv`):

- **Pick 24, Jay → Tina Charles** (was Luisa Geiselsoder). Tina was missing from the DB entirely — NOTES CP2 had flagged her as retired/unsigned and the WNBA.com /players scrape didn't return her. She signed with Connecticut Sun for 2026. Inserted with `wnba_team='CON'`, `positions=["C"]`, `is_rookie=False`, `stats_source='wnba_actual'`. **No 2024/25 stats backfilled** — once the in-season refresh starts pulling 2026 actuals, that becomes her value basis. Worth revisiting at next year's draft prep when historical IS the basis.
- **Pick 41, Jay → Azzi Fudd** (was Laeticia Amihere). Fudd was already in the DB (id=82, DAL, rookie). Search-as-you-type failure during the draft — CSV also misspells her as "Azi Fudd".
- **Pick 47, Sean → Luisa Geiselsoder** (was Temi Fagbenle). Luisa was in the DB but had been used as Tina's filler at pick 24, so she wasn't available later in the draft.

Slot rebalance on Jay's roster: Aliyah Boston (C/F) moved C → F to free C for Tina; Azzi Fudd took UTIL since G was full. Sean's pick 47 swap kept slot C. All 8 teams still have a valid 2G/2F/1C/1UTIL fill; 48 unique picks; 48 draft transactions logged.

Applied via direct SQL (idempotent: roster + transaction rows updated in place; player record for Tina inserted). Did NOT use the draft endpoints — undoing 25 picks to redo them would have churned the transaction log unnecessarily.

Known follow-up: re-run the rookie projections + value scorer at some point so Tina has any value at all; for now her value will be 0 until her 2026 `wnba_actual` row lands.

---

## 2026-05-03 — Checkpoint 7: Per-game stat ingest

### Why per-game (not season totals)
The Phase 2 rotisserie scoreboard must support **backdated trades** — the user logs other teams' add/drops/trades from the official sheet and routinely back-dates them. Stat attribution by ownership window can't be done from season totals; we need a row per game so the aggregator can split a player's contribution across owners.

The CP2 season-totals pipeline (Rotowire) stays in place for 2024 + 2025 — those are historical, no backdating needed. CP7 only adds 2026 per-game ingest.

### Source: basketball-reference (over Rotowire)
Rotowire is what we already use for season totals, but their per-game endpoint is harder to discover and our existing daily totals scrape will catch revisions anyway. BBR per-player gamelog is straightforward static HTML once you strip their HTML-comment ad-blocker wrappers (same trick as the CBB scraper).

URL pattern: `/wnba/players/{first_letter}/{slug}/gamelog/{season}/`. Example: A'ja Wilson → `/wnba/players/w/wilsoa01w/gamelog/2025/`. Table id `wnba_pgl_basic` (regular season).

BBR gotchas:
- Default User-Agent gets 403'd. Existing `RateLimitedSession` UA works fine.
- Gamelog table is wrapped in `<!-- ... -->`; strip comments before BS4.
- DNP / inactive rows have non-numeric `mp` — skip them.
- The "totals" page table id is `totals` (not `totals_stats` or `per_game_stats`).

### Schema additions
- `players.bbr_slug` — BBR player slug, populated by `discover-bbr-slugs.py` via normalized-name match against the season totals page. Idempotent migration in `_ensure_columns`.
- `game_stats` table — one row per (player, game_date), UNIQUE on `(player_id, game_date)`. Carries `team` (the WNBA team the player suited up for that day; handles WNBA-side mid-season trades) + `opponent` + `is_home` + `started` + 5 cats + minutes + source + fetched_at.
- Indexes: `(player_id)`, `(game_date)`, `(season, game_date)` for the scoreboard's time-window queries.

### Ownership-window aggregation deferred to CP9
The schema supports it, but no scoreboard query is built yet. CP8 reads "current ownership × game_stats" only. CP9 adds the partitioning logic when the transactions UI lands.

### Scripts
- `scripts/discover-bbr-slugs.py [--season 2025]` — one-time bootstrap. Scrapes BBR totals, name-matches against `players`, populates `bbr_slug`.
- `scripts/refresh-gamelogs.py [--season 2026] [--slug X] [--limit N]` — daily ingest. Iterates players-with-slugs, scrapes each gamelog, upserts `game_stats`. Single-player smoke path via `--slug`.

### Bootstrap state (from 2025 totals)
- 182 players in BBR's 2025 totals page
- 146 / 285 DB players matched by normalized name. Updated in place; idempotent on rerun.
- 3 / 48 rostered players unmatched: Azzi Fudd, Olivia Miles (rookies), Luisa Geiselsoder (international with no prior WNBA play). Skipped silently by `refresh-gamelogs.py` (filter is `bbr_slug IS NOT NULL`); they'll get slugs once they appear in 2026's totals page (BBR populates it as games are played).
- Tina Charles matched to `charlti01w` — she did play in 2025 after all (CP2 NOTES had flagged her as retired, evidently outdated).

### Verification
- Smoke `--slug wilsoa01w --season 2025` → 40 games scraped, all 5 cats present, dates ISO-parsed, minutes converted from `MM:SS` to decimal. Matches her 2025 GP exactly.
- Smoke `--season 2026 --limit 5` → 0 games for all 5 players (pre-season). Empty pages handled gracefully (BBR returns 200 with no `wnba_pgl_basic` table; parser returns `[]`).
- DB: `game_stats` has 0 rows post-smoke — exactly the live-scoreboard starting state per the user's "everyone at 0 today" rule.

### Refresh.py integration deferred
`refresh-gamelogs.py` is intentionally separate from the daily `refresh.py`. Game logs grow ~150 fetches/day (~7 min); season totals + injuries are ~75 sec. Different cadences make sense — totals + injuries can be triggered manually anytime, gamelogs run once a day after the slate. May fold into a single launcher in CP12 polish.

### Known gaps
- Rookie / 2026-only signing slug discovery: when 2026 totals page populates (post-season-start), re-run `discover-bbr-slugs --season 2026` to fill in Fudd / Miles / Geiselsoder. Earlier (during the season) we'd need a name-search fallback against BBR's player search. Defer until it bites.
