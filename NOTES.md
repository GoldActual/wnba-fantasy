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
