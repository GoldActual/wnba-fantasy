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

---

## 2026-05-03 — Checkpoint 8: Live scoreboard

### Surface scope
Brand new view: shows each fantasy team's 2026 totals + per-cat rotis rank + rank-sum standings, all 8 teams, click-to-expand for the per-player breakdown. Pre-season everyone is at 0 in every cat, all teams tie for 1st (rank-sum 22.5). Once 2026 games land in `game_stats`, ranks shift live.

### Backend (`app/standings.py` + `routers/standings.py`)
- `compute_standings(db, season)` — joins current `rosters` × `game_stats` (season filtered), aggregates 5 cats per team, ranks per cat with **tie-aware averaging** (8 teams tied at 0 each get rank (1+8)/2 = 4.5 — clean pre-season state), sums to rank-sum, derives final standing from -rank_sum (lower = better).
- `aggregate_team_totals(db, team_player_map, season)` is split out so CP11's transaction simulator can call it with mocked rosters (drop X, add Y → here are the new totals).
- `_project_total(current, team_games, full_season)` — linear extrapolation per team: `current × 44 / team_games`. Per-team denominator (not global) so a team whose roster has fewer game-played rows projects from its own pace, not penalized by another team's faster start. `team_games_played = max GP across roster` (rough "weeks elapsed for this team").
- Endpoint: `GET /api/standings?season=2026` → flat JSON with teams sorted by standing, includes per-team `cats[c] = {total, rank, projected}` and the full player breakdown inline.

### Backdating: deferred to CP9
Reads current ownership only. Schema supports ownership-window attribution via `transactions.effective_date`; aggregator will be swapped for the windowed version once the transactions UI lands.

### Frontend (`views/Scoreboard.tsx`)
- Table: standing # / Owner (★ for is_my_team) / Σ rank / GP / 5 cats with `total #rank`. Click a row → inline player table appears under it (same shape as the team-total row), with rookie + injury badges on each player.
- "Show projection" header toggle flips the per-cat cells from current totals to full-season projections. Player table footer also shows a projected row when toggled on.
- Pre-season explainer line below the table when `league_games_to_date === 0`. Disappears once games land.

### Routing (`App.tsx`)
- New `Mode = 'loading' | 'setup' | 'draft' | 'scoreboard'`.
- After draft setup is done: if `is_complete`, default to `scoreboard`. If still drafting, default to `draft`. Both views have a header button to flip to the other.
- Draft.tsx now takes optional `onSwitchToScoreboard`. The Scoreboard button only renders if that prop is supplied (Setup → Draft initial path doesn't need it).

### Verification
- Pre-season: all 8 teams at rank 4.5 in every cat, rank-sum 22.5, all tied for 1st. Confirmed via direct call into `compute_standings`.
- Synthetic injection (1 game per top-3 teams, rolled back): A'ja Wilson 30/15/4/2/3 → Cole rank-sum 7.5 standing 1; Sean and Bubba ordered correctly behind. STL ties (2-2) split at rank 1.5; BLK 6-way tie at 0 averaged to 5.5. Math matches PLAN.md rotis convention.
- Endpoint smoke via `TestClient` (httpx wasn't installed, fell back to direct serializer call) and live `curl http://localhost:8000/api/standings?season=2026` — both return 200, payload structure as expected.
- Frontend `npx tsc --noEmit` clean.

### Visual verification still needed
I haven't opened the page in a browser. User should `launch.bat` (or `uvicorn ...` + `npm run dev`) and confirm: scoreboard renders, all 8 teams in the table, expand-row works, projection toggle flips totals, Draft-board button toggles back to the existing draft view.

### Known follow-ups
- A live "since-last-refresh" delta (who moved up/down rank-sum) would be nice. Not built — defer to CP12 polish or a dedicated CP if the user finds it valuable.
- `FULL_SEASON_GAMES = 44` is a constant in `standings.py`. If the WNBA tweaks the schedule mid-2026, just bump it. Confirmed via CBS Sports schedule release: 44 games per team in 2026.

---

## 2026-05-03 — Checkpoint 9: Transaction ledger UI (any team, back-date-able)

### Why this is core, not polish
The user logs every team's add/drop/trade — the league doesn't notify, so they're back-dating from the official sheet. Means:
- All forms accept any team_id (not just is_my_team).
- Effective dates settable backwards; the standings aggregator must honor ownership windows so backdated trades reattribute past stats correctly.
- Per-team transaction-budget visibility (4 = 2 strategic + 2 injury) — the scarcity drives every move.

### Schema
- Two new columns on `transactions` (idempotent migration in `_ensure_columns`):
  - `event_id` (TEXT, indexed) — UUID4 grouping rows that constitute one logical league event.
  - `category` (TEXT) — 'strategic' | 'injury' on event-driven rows; null on 'draft' / 'team_dissolved'.
- One pickup = one event_id with two rows (`type='add'` + `type='drop'`). One trade = one event_id with two `type='trade'` rows (one per player). Counted as ONE transaction per involved team. 'draft' rows have null event_id and don't count.
- The dropped player's slot is encoded in the drop row's `notes` field as `[slot=C]` (or `G` / `F` / `UTIL`) so undo can restore the slot. Otherwise the slot info would be lost when the added player took the dropped player's spot.

### `app/transactions.py` — domain logic
- `ownership_windows_for_player(txs)` → `[(start, end_inclusive_or_none, team_id)]`. Walks chronologically. Effective_date is **inclusive** for the new owner — a game on the trade date attributes to the new team. Out-of-order data closes the previous window the day before the new one starts.
- `build_ownership_timelines(db)` → `{player_id: windows}` for every player who has any transaction history.
- `owner_on_date(windows, d)` → team_id or None — used by the scoreboard aggregator.
- `record_pickup(...)` and `record_trade(...)` — atomic write of Transaction rows + Roster mutation. Validate that the dropped player is on the team and the added player is currently FA; trades validate both players' rosters.
- `delete_event(event_id)` — undo an event by reversing Roster mutations and deleting all rows sharing the event_id. Slot is restored from the encoded `[slot=X]` tag.
- `usage_by_team(db)` → `{team_id: TeamUsage}` — counts distinct event_ids per team, split by category. The scoreboard's roster shape and the 4/team budget are independent of this — usage just counts events, doesn't enforce.

### Standings now honors ownership windows
`compute_standings()` in `app/standings.py` was rewritten:
- Per-game stats attribute to whichever team owned the player on the game's date (via `owner_on_date`).
- The team panel now shows current rostered players AND any "departed" contributors whose pre-trade tenure on this team still credits to them. Departed rows have `is_current_roster=false`; the frontend italicizes them and labels "traded away".
- `aggregate_team_totals(team_player_map)` (the hypothetical-rosters helper for CP11 simulator) is unchanged — it intentionally ignores history so the simulator can answer "if these were the rosters today, ...".

### Endpoints — `app/routers/transactions.py`
- `GET /api/transactions` → `{events, usage, limits}`. Events grouped by event_id, sorted desc by effective_date. Each event's `event_type` is derived ('pickup' from add+drop legs, 'trade' from trade legs).
- `POST /api/transactions/pickup` body: `{team_id, add_player_id, drop_player_id, effective_date?, category, note?}` → `{event_id}`. 400 on validation errors (player not on team, etc.).
- `POST /api/transactions/trade` body: `{team_a_id, team_a_player_id, team_b_id, team_b_player_id, effective_date?, category, note?}` → `{event_id}`.
- `DELETE /api/transactions/{event_id}` → `{deleted_rows, event_id}`. Reverses Roster + deletes the event's rows.

### League rule: no team-to-team trades
Confirmed during build: every transaction in this league is "drop one rostered player, add one free agent" — always 1-for-1, no team-to-team swaps. The user calls these "trades" colloquially. PLAN.md mentioned team-to-team trades and the schema supports them, but the league has never run them.

The backend `record_trade` function and `POST /api/transactions/trade` endpoint are kept (working, tested, future-proof against a rule change) but **not exposed in the UI**. The frontend has only the pickup-style form, labeled "Trade" to match the user's vocabulary.

### Frontend — `views/Transactions.tsx`
- Header with Scoreboard + Draft toggles.
- Per-team usage panel: 8 cards, each with strategic / injury progress bars (green / amber / red).
- Single "+ Trade" button reveals the form: team picker, current-roster drop selector, FA search-as-you-type with a sized listbox, effective-date input, strategic/injury radio, optional note.
- Audit log below — each event renders as one summary line with effective date, category badge, the leg summary ("Cole: drop X, add Y"), optional note in italics, and an Undo button (with `confirm()`).
- Errors from the API surface in a red banner at the top.

### App.tsx routing
- `Mode` adds `'transactions'`. Header buttons cycle Scoreboard ↔ Draft ↔ Transactions; default is still Scoreboard once the draft is complete.

### Scoreboard view tweak
- Team panel header: "Roster (N) — M games played · K traded-away contributors below" when departed players exist.
- Departed rows render italic + grayed + label "traded away" next to their position info.

### Verification
- `init_db()` migration applied — `transactions` table now has `event_id` + `category` columns.
- Pickup smoke: Cole drops A'ja, picks up Monique Akoa Makani (effective 2026-05-15, strategic). Roster updated; usage = 1 strategic for Cole. Undo restores A'ja to slot C (the encoded slot tag worked). Rolled back.
- Trade smoke: A'ja↔Caitlin between Cole and Sean effective 2026-05-20. Pre-injected 4 games for each player (5/8, 5/15, 5/22, 5/29). After ownership-window aggregation: Cole's PTS = 90 (A'ja pre-trade) + 58 (Caitlin post-trade) = 148. Sean's PTS = 45 (Caitlin pre-trade) + 80 (A'ja post-trade) = 125. Both teams' panels include the traded-away contributor in their breakdown. Math matches the manual calculation. Rolled back.
- Empty state via curl `GET /api/transactions`: 0 events, 8 usage rows (4-remaining each), limits returned.
- Frontend `npx tsc --noEmit` clean.

### Known limitations / follow-ups
- Backdating that crosses an existing later event isn't auto-cascaded by the undo path; user must delete events in reverse chronological order (UI doesn't enforce this; we surface it as a usage rule). The user is the only operator, so this is fine.
- No "preview impact before committing" dialog yet. Defer to CP11 simulator — that's the natural home for "if I do X, here's the standings delta" reasoning.
- Visual verification still owed (user is on mobile). All TS / endpoint smokes are green.

---

## 2026-05-03 — Checkpoint 10: FA finder + drop candidates

### Value basis cutover (`app/value.py`)
The big behavioral change: `_basis_stats_by_player` now picks current-season actuals from `game_stats` once a player has at least `SEASON_BASIS_GAMES_THRESHOLD = 10` games in 2026. Below the threshold we keep prior-year basis (so the FA finder + drop-candidate views aren't garbage in the first 2 weeks).

`_aggregate_current_season_basis(db)` builds synthetic `StatsSeason` rows in memory from the per-game logs — not persisted. The synthetic row carries the cat sums and the games_played count; the existing value pipeline (z-scores × availability × position × injury × rookie) reads it like any other basis row.

Priority order:
1. Current-season actuals (≥ 10 GP in 2026).
2. Prior-year `wnba_actual` (most recent healthy season, MIN_HEALTHY_GAMES = 35).
3. Rookie projection (`ncaa_projection`).

Smoke verified:
- Pre-season top 5 unchanged (A'ja, Alyssa, Caitlin, Stewart, Aliyah) — no game_stats means everyone falls through to prior-year.
- Inject 10 mediocre 2026 games for A'ja → her value drops from 14.48 to -0.83 (current-season basis kicks in). With 9 games she stays at 14.48 (below threshold, prior-year still wins). Cutover behavior is sharp and correct.

### Frontend — `views/Players.tsx`
Single in-season player view with two modes:
- **Free Agents** (default) — un-rostered players, sorted by value desc. "Top of the list is the strongest available pickup."
- **Roster Health** — pick any team via the selector (defaults to ★ my-team), shows that team's 6 players sorted by value asc. The lowest-value row is highlighted with a `DROP CANDIDATE` badge. Works for opponents too — useful for spotting their weaknesses.

Filters mirror the Best Available view: search box, position tabs (All/G/F/C), Hide Out toggle. No rookie filter — by mid-season rookies are just players, and the cutover means their stats are real.

The full nav header is on every view now: Scoreboard / Players / Transactions / Draft board. App.tsx routes between them. Default home post-draft remains Scoreboard.

### What's deferred to CP11
- The actual "what if?" simulator that compares a hypothetical drop+add against current standings. The Players view shows you who's best and who's weakest, but doesn't yet model the standings delta of a specific swap. That's CP11's whole purpose.

### Known follow-ups
- Three rostered players still have no `bbr_slug` (Fudd, Miles, Geiselsoder — pre-WNBA-debut). Once they play and BBR's 2026 totals page lists them, re-run `discover-bbr-slugs --season 2026`. Until then they show prior-year basis = projection or zero, which is correct.
- The "Hide Out" filter is a hard exclude. Could add a "Hide DTD" too, but DTD players sometimes still play — leaving them visible (with the 🟡 badge) is the safer default.
- Visual verification still owed across CP8/CP9/CP10.

---

## 2026-05-06 — Checkpoint 11: drop+add simulator

### Backend — `app/simulator.py` + `routers/simulator.py`
`POST /api/simulator/pickup` accepts `{team_id, drop_player_id, add_player_id}` and returns full before/after worlds. Pure read model — no DB writes.

Attribution model is **all-season retroactive (option A)**: pretend the swap was in place from day 1. Every team's totals come from `aggregate_team_totals` over current rosters (after swap, for the picking team), summing 2026 game_stats. This intentionally diverges from the live scoreboard for any team that has executed a backdated trade — the live view honors ownership timelines, but the simulator's "before" baseline pretends current rosters were always current. Right framing for "would I be better off going forward?", and keeps before/after directly comparable.

Other-team note: in this league there are no team-to-team trades, so the dropped player's stats simply vanish from the picking team in the after-world (they hit FA, no other team picks them up in the hypothetical). The added FA's full-season stats credit to the picking team. Other teams' totals are unchanged from before, so any rank shifts on other teams are pure consequences of the picking team's cat totals moving past or below them.

Reused helpers from `standings.py` (kept private but stable signatures): `_rank_with_ties`, `_project_total`, `aggregate_team_totals`. Flat reuse — the world-builder is a thin loop over teams. `team_games` per simulated roster is `max(GP across roster)` for the projection denominator.

Validation (returns 400 with descriptive message):
- drop must be on `team_id` (errors with the actual owner if it's on someone else, or "is a free agent" if unrostered).
- add must be currently unrostered.
- drop ≠ add.
- team must be active.

Smoke verified directly:
- Symmetric swap (drop big stats, add same big stats) → totals identical, standings unchanged. ✓
- Asymmetric swap (drop big, add baseline) → Cole's pts 400→300, rank_sum 5.0→22.5, standing 1.0→4.5. ✓
- All four error paths return descriptive `SimulatorError`. ✓

### Frontend — `views/Simulator.tsx`
Two-column setup card: pick a team (defaults to ★ my-team), radio-select one of their 6 to drop (sorted by value asc — lowest first, matching CP10 Roster Health), radio-select an FA (sorted by value desc, search + position filter, capped at top-50 visible to keep the list scannable). Big "Run simulation" button.

Result panel:
- Picking-team summary card with 4 metrics (standing, rank_sum, GP basis, league GP) — shows before strikethrough + after + Δ. Color: lower-is-better tones flip vs. higher-is-better cat totals. Picking team's per-cat total + rank delta table below.
- All-teams overview table — every team's standing, rank_sum, and 5 cat ranks, with before→after pairs. Picking team highlighted sky-blue.
- "Other teams that shifted" amber callout when a non-picking team's overall standing changed, so the user notices when a swap reshuffles more than just their own row.

The full nav header now has 5 links across all views: Scoreboard / Players / Simulator / Transactions / Draft board.

### Out of scope (deferred)
- Effective-date picker (option B from CP11 design — partial-credit for from-date-forward swaps). Reasonable v2 if the all-season-retroactive framing ever feels wrong; it isn't today.
- Trade-tree / multi-step (drop A add B then drop C add D) sims.
- Persisting saved scenarios.
- The simulator does NOT account for the 4-transaction-per-season cap. Cap usage lives in the Transactions view; not relevant for "what if" reasoning.

### Known follow-ups (still)
- Visual verification still owed across CP8/CP9/CP10/CP11.
- Three rostered players still have no `bbr_slug` (Fudd, Miles, Geiselsoder).

---

## 2026-05-14 — Checkpoint 13: Cat-targeting strategy view

### Why this surface exists
5-cat rotis with only 4 transactions per season is won by **deciding what to punt**, not by being balanced. The existing tools (FA finder, simulator) answer "is X a good pickup?" but never "is this cat worth spending a transaction on at all?". Strategy view fills that gap: each cat classified Lock / Contend / Punt with projected end-of-season rank, gap-up, gap-down. Suggested weights for FA reweighting are computed but not yet applied to the value pipeline (CP14).

### `app/strategy.py` — pure layer on top of standings
- Reuses `compute_standings()` (so ownership-window attribution from CP9 is honored automatically) plus the private `_rank_with_ties` for projection ranking.
- For each cat: project end-of-season total using current team pace (`current * 44 / team_games`), re-rank teams on those projected totals to get `projected_rank`, compute `gap_up` and `gap_down` to the strictly-greater / strictly-lesser projected total.
- Classification:
  - **Lock**: no team strictly above me (gap_up is None — includes ties at #1) AND gap_down >= 15% of my projected total.
  - **Punt**: in bottom 3 ranks AND |gap_up| >= 25% of the team-above's projected total.
  - **Contend**: everything else.
  - Encoded `gap_up is None` rather than `projected_rank <= 1` so ties at #1 stay Lock-eligible — being tied for first with a safe cushion is still "at the top".
- `low_sample` flag set when avg team_games < 10. Doesn't force a classification — the math runs honestly; the UI shows a warning so the user can discount early-season noise without losing the signal.
- Suggested weights for the CP14 FA reweighting hook: Lock = ×0.4, Contend = ×1.5, Punt = ×0.0.
- Head-to-head: for every other team, per-cat (my_total, opp_total, gap, projected_gap, status). W-L-T summary at the top.

### Endpoint
- `GET /api/strategy?team_id=N&season=2026` → flat JSON, single payload per team. 400 with descriptive message if team_id isn't found.
- Wired into `main.py` next to the other routers.

### Smoke verification (today, 2026-05-14, avg_team_games=2.8 — low_sample regime)
- Cole (st=3, rs=14): AST=Lock (tied 1.5 with Bubba at projected 836, gap_down=+154 vs #3 at 682), everything else Contend. ✓
- Bubba (st=1, rs=9): AST=Lock (mirror of Cole). ✓
- Tom (st=8, rs=36): POI/AST/STE/BLO all Punt. ✓
- Eric (st=2, rs=12): BLK=Lock. Nik (st=4): STL=Lock, BLK=Punt. ✓
- Initial implementation had `projected_rank <= LOCK_TOP_N` for Lock; ties at #1 (rank 1.5) failed the check. Refactored to `gap_up is None` — semantically what "at the top" means and naturally tie-tolerant.

### Frontend — `views/Strategy.tsx`
- Team picker (defaults to ★ my-team; works for any team — line with the all-teams-editable pattern).
- Standings forecast table: Cat | Now | Proj | Rank now → proj | Gap↑ | Gap↓ | Class | Weight. Class badge color-coded emerald/sky/amber. Tooltips on gap columns explain the sign.
- Low-sample warning banner above the forecast when applicable.
- Head-to-head section: row of opponent buttons (each with name + W-L-T summary, sorted by their current standing), click to see per-cat detail table with current Δ + projected Δ + status badge.
- Default opponent: the team currently ranked one position above me (the practical "who do I need to catch?" framing).
- Full nav header: Scoreboard / Players / Strategy / Simulator / Transactions / Draft, plus Sync + Theme.

### App.tsx routing
- `Mode` adds `'strategy'`. Auto-stays on strategy mode if user is there when state refreshes. Every other view gains an `onSwitchToStrategy` prop + "Strategy" button in its nav header.

### Out of scope (CP14 candidates)
- **FA value reweighting** — the suggested weights are returned but not yet applied to `value.py`. CP14 will add a `cat_weights` parameter to the value pipeline and a `strategic_team_id` query param to `/api/players` that automatically pulls the weights for that team.
- **Manual override** of classifications — for cases where the user has private info (e.g., "Sean's PG just got cut, BLK is more in play than the math says"). Likely a small `team_strategy_overrides.json` file or DB table.
- **Transaction-budget-aware Punt threshold** — currently uses a flat 25% gap. Could compute "max plausible gain from N remaining transactions" per cat and use that as the unreachability floor.

### Known limitations
- Classifications are early-season-noisy until ~10 games per team (low_sample banner makes this explicit). Today's view is mostly Contend everywhere except for a few clear ties-for-first; will sharpen as data accumulates.
- TestClient HTTP smoke test required `httpx` (not installed; same situation as CP8). Verified the serializer + endpoint logic by direct call to `_serialize(analyze_team(...))` — JSON shape matches the frontend types exactly.
- Visual verification still owed (user is the only operator).

---

## 2026-05-14 — Checkpoint 14: strategy-weighted FA value

### Why this is the actual decision-changer
CP13 surfaces classifications; CP14 makes them affect the FA value column. Without this, the strategy view is just a dashboard — the user still picks FAs from the same flat z-score sum. With CP14, the FA list automatically deprioritizes Locked cats and zeroes out Punted cats, so the top of the list reflects what the user actually needs to push, not what would help a generic team.

### Backend — `value.py` + `routers/players.py`
- `compute_weighted_value(pv, cat_weights)` in `value.py`: mirrors `compute_marginal_value` but applies per-cat weights to z-scores before multiplying through availability / position / injury / rookie factors. Single function; ~10 lines.
- `routers/players.py`:
  - New `strategic_team_id` query param.
  - When provided, calls `analyze_team` to get weights, computes `strategy_weighted_value` for every player, re-sorts the list by it.
  - Bad `team_id` is silently swallowed (returns flat ordering) — the strategy endpoint already 400s, no need to break the players list over it.
  - Response gains `strategic_team_id`, `strategy_weights` (per-cat dict), and `strategy_weighted_value` per player (null when no strategy applied).

### Smoke verification (Cole, 2026-05-14, AST=Lock all others Contend)
- Cole's weights from analyze_team: `{PTS: 1.5, REB: 1.5, AST: 0.4, STL: 1.5, BLK: 1.5}`.
- Flat top 10: A'ja Wilson, Alyssa Thomas, Caitlin Clark, Stewart, Boston, Hamby, Magbegor, Smith, Stevens, Collier.
- Weighted top 10 for Cole: A'ja Wilson, Stewart, Boston, Magbegor, Stevens, Hamby, Smith, Collier, **Alyssa Thomas (#9)**, **Caitlin Clark (#10)**.
- Thomas (AST_z=+4.45) and Clark (AST_z=+4.14) drop from #2/#3 to #9/#10 — their assist specialty isn't worth as much to a team that's already Locked the cat. Exactly the behavior we wanted. ✓

### Frontend — `views/Players.tsx`
- "Apply strategy weights" toggle in the filter row. Off by default.
- When on, the team selector appears (even in FA mode, since the user needs to pick whose strategy applies) and a caption shows the active weights: "PTS×1.5 · REB×1.5 · AST×0.4 · STL×1.5 · BLK×1.5".
- Table gains a "Weighted" column (only when toggle is on). Original Value column de-emphasizes (regular weight, slate-500) so the weighted score is the visual primary.
- Sort + drop-candidate detection both fall back to weighted value when available. Backend already sorts that way; frontend re-sort matches so filtering (search, position, hide-out) doesn't shuffle the order back.
- `refresh()` re-fetches when applyStrategy or teamId changes — accepts a single duplicate fetch on initial load (teamId starts null, gets defaulted, useEffect fires again) in exchange for the simpler effect-dependency model.

### Out of scope
- Manual classification override (still deferred — same hook as CP13).
- Strategy weights in the Simulator. Could be useful: "if I do this swap with my current strategy applied, here's the standings impact". For v1 the Simulator stays unweighted since it's modelling the actual cat totals, not value scores.
- Re-fetching strategy on a sync completion (right now the strategy weights snapshot at fetch time; if the user clicks Sync and gamelogs update, they need to toggle off + on to recompute).
- The `for_team_id` (draft-time pace bias) and `strategic_team_id` are independent and can coexist on the same request, but they don't compose meaningfully — `for_team_id` is a draft-time concept. UI never sends both.
