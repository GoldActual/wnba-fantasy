# WNBA Fantasy Draft & Season Tracker — Build Plan

## Context

I'm in a season-long WNBA fantasy league (currently 8 teams, 10 years running). My draft is **Saturday, May 2, 2026** — three days away. The 2026 WNBA regular season starts May 8. I need a tool ready by Saturday morning for the draft, then we'll extend it during the season.

**Today is Wednesday, April 29, 2026.**

## League Rules

- N teams (typically 8, but configurable per season — must support adding/removing teams), snake draft, in person
- Each roster has 6 players: 2 Guards, 2 Forwards, 1 Center, 1 Utility (any position)
- WNBA player positions are defined by WNBA.com (some players are dual-eligible, e.g., "Forward-Guard")
- Season-long rotisserie scoring: 5 categories — Points, Rebounds, Assists, Steals, Blocks
- Total season stats per category, ranked 1–N across teams in each category, lowest total rank wins
- **Only 4 transactions allowed all season** (2 strategic + 2 injury) — this constraint matters a lot for the season-long tool
- Trades between teams are allowed; the tool must support **backdating trades** so that stats accumulated by a player are credited to whichever team owned them at the time

## Tech Stack

- **Backend:** Python 3.11+ with FastAPI
- **Database:** SQLite (file-based, single-user)
- **Frontend:** React + Vite + Tailwind CSS
- **Scraping:** `requests` + `BeautifulSoup` for static HTML; investigate Rotowire's network requests to find a JSON endpoint before reaching for Playwright
- **Hosting:** Local on my Windows PC. I'll access it via `localhost` on my PC and via local IP from my phone on home WiFi.
- **Run:** `uvicorn` for the API, `vite dev` for the frontend, both in separate terminals

## Data Sources (all free)

| Need | Source | Notes |
|---|---|---|
| Historical season stats (2024, 2025) | `https://www.rotowire.com/wnba/stats.php?statType=total&season=2025` (and `season=2024`) | Table is JS-loaded — inspect network tab to find the JSON endpoint. Fall back to `https://www.basketball-reference.com/wnba/years/2025_totals.html` if Rotowire is too hard. |
| Player positions (with dual-eligibility) | WNBA.com player pages | Positions like "Forward-Guard" must be parsed into an array `["F", "G"]` |
| Injury reports | `https://www.espn.com/wnba/injuries` | Static HTML — easy scrape. Includes status (Out / Day-To-Day), estimated return date, and ESPN player IDs in player URLs |
| **2026 rookie NCAA stats** | `https://www.sports-reference.com/cbb/women/` | For projecting rookies who have no WNBA history. Scrape final college season per-36 stats. |
| **2026 WNBA Draft results** | `https://www.wnba.com/draft/2026/board` or ESPN | Need draft pick number for each rookie to estimate WNBA minutes |
| Daily lineups (Phase 2) | `https://www.rotowire.com/wnba/lineups.php` | For pre-game starter confirmations during the season |

**Scraping etiquette:** cache aggressively, set a real User-Agent, no parallel requests, no faster than once per few seconds. Build a shared `scrapers/` module with rate limiting baked in.

## Data Model — Key Decisions

- `player.positions` is a **JSON array** of single-letter codes: `["G"]`, `["F", "G"]`, `["C", "F"]`, etc. Roster slot eligibility checks if the player's position array intersects with the slot's allowed positions. Utility accepts anyone.
- Use **ESPN player IDs** as a stable cross-source identifier where available (extracted from URLs like `/player/_/id/3917450/napheesa-collier`).
- `transactions` table records every roster change with an `effective_date` field. Stat aggregation joins player stats to whichever team owned the player on the date the stat was recorded. This is what makes trade backdating work.
- **Teams are normal DB rows**, not hardcoded columns — the schema must support any team count from 2–16.
- **Player records have an `is_rookie` boolean and a `stats_source` enum** (`wnba_actual` | `ncaa_projection`). Rookies use projected stats with the same schema as veterans, but flagged so the UI can badge them clearly.

## Rookie Projection Approach

Rookies have no WNBA stats, so the z-score model would rank them dead last. The 2026 class is deep (Azzi Fudd #1, Olivia Miles #2, Awa Fam Thiam #3, Lauren Betts #4, six UCLA players drafted) and Toronto/Portland expansion teams will play their rookies heavy minutes. Ignoring rookies = bad picks.

**Method:**

1. Scrape final NCAA season stats (per-36-minute rates) for each 2026 rookie from sports-reference.com/cbb/women
2. Apply translation factors to estimate WNBA per-36 production:
   - PTS ~55% of NCAA per-36
   - REB ~70%
   - AST ~60%
   - STL ~50%
   - BLK ~50%
   - (These are starting values. Tunable in a config file.)
3. Estimate WNBA minutes from draft position:
   - Picks 1–4 (likely on rebuilding/expansion teams): 25–30 MPG
   - Picks 5–12: 18–25 MPG
   - Picks 13–24: 8–15 MPG
   - Picks 25+: 0–8 MPG
4. Estimate games played: 36 (full season for healthy rookies; manually flag known injuries)
5. Compute totals (per-36 × MPG × games / 36) and feed into the same z-score pipeline as veterans
6. Apply a **30% confidence discount** to the final value score (multiply by 0.7) to reflect projection uncertainty
7. **Manual override layer:** a config file (`rookie_overrides.json`) where I can bump or tank specific rookies on draft morning based on preseason buzz, training camp reports, or vibes. UI exposes this as an editable field.

**UI treatment:** every rookie shows a 🆕 badge next to the value score. Hovering reveals "Projected from [school] [year] stats — high uncertainty." Toggle in the UI to hide rookies entirely (for risk-averse rounds) or show only rookies (for late-round dart throws).

**Optional backtest** (skip for time, do later if curious): pull 2024 rookies' college senior stats, project with these factors, compare to actual 2024 WNBA output, tune multipliers. About an hour of work. Not on the critical path for Saturday.

## Phase 1: Draft Day Tool (must be ready by Saturday May 2)

### Features

1. **Player database** pre-loaded with:
   - Veterans: 2024 + 2025 WNBA season stats (totals + per-game + games played + minutes), positions, ESPN ID, current team, current injury status
   - Rookies: NCAA-projected WNBA stats with `is_rookie=true` flag, draft pick number, projected MPG, override field
2. **Custom value score** ranking players for *this specific 5-cat league*:
   - Z-score each player against the league mean in each of PTS, REB, AST, STL, BLK (using totals)
   - Sum the 5 z-scores
   - Multiply by `min(1, games_played / 32)` to penalize low-availability players
   - Add small bonus (~3–5%) for dual-position eligibility, larger bonus for triple-eligibility
   - Heavy penalty (multiply by 0.4) if currently flagged as "Out" on the ESPN injury page
   - **Rookies: multiply final score by 0.7 confidence discount, then apply any manual override**
3. **Draft board UI**:
   - Configurable team count and team names entered before the draft
   - Snake-order tracker showing whose pick is on the clock
   - Aggressive search-as-you-type for assigning picks (the draft is in person and chaotic — speed matters)
   - When a multi-position player is picked, prompt which slot they're filling (default to the most restrictive open slot)
   - Undo button with a stack of recent picks (mis-clicks will happen)
   - Greying out drafted players from the available pool
4. **Best Available view**, sortable, filterable by position need, with badges on every player card:
   - Injury: 🔴 Out / 🟡 Day-to-Day / 🟢 Healthy
   - Rookie: 🆕 with hover-reveal of projection source
   - Filter toggles: "Hide rookies" / "Rookies only"
5. **My Team panel**:
   - Visual indicator of positional slots filled vs. needed (2G / 2F / 1C / 1UTIL)
   - Live category strength projection — for each of the 5 cats, show projected season totals based on currently rostered players, so I can spot category weakness mid-draft
6. **Other Teams panel** — same view, lighter detail, so I can see what categories opponents are stacking
7. **Rookie override editor** — quick UI to bump/tank specific rookies before the draft starts
8. **CSV export** of the final draft as a safety net

### Phase 1 Build Order

Please build this **incrementally** and stop for my review at each checkpoint. Do not try to one-shot the whole thing.

**Checkpoint 1 — Project scaffold**
- Create `/backend` (FastAPI app, SQLite, scrapers module skeleton) and `/frontend` (Vite + React + Tailwind)
- Define the SQLite schema (`players`, `teams`, `rosters`, `transactions`, `stats_seasons`, `injuries`) with `is_rookie` and `stats_source` fields on `players`
- Wire up a hello-world API call from the frontend to confirm the stack works
- **Stop and show me before continuing.**

**Checkpoint 2 — Veteran data ingestion**
- Investigate Rotowire's stats page network requests to find the JSON endpoint. If found, scrape it. If not, use Basketball Reference.
- Scrape 2024 and 2025 season totals into the DB
- Scrape WNBA.com positions, store as JSON arrays
- Scrape ESPN injury page, store with status + return date + ESPN player ID
- Build a one-command "refresh all data" script
- **Stop. Show me a sample of the data so I can sanity-check it before we build UI on top of bad data.**

**Checkpoint 3 — Rookie ingestion + projection**
- Scrape 2026 WNBA Draft results (pick number, team, school) from WNBA.com or ESPN
- Scrape NCAA senior season per-36 stats from sports-reference.com/cbb/women for each rookie
- Implement translation factors and MPG estimation in a `projections.py` module with config-file-tunable multipliers
- Insert rookies into the same `players` table with `is_rookie=true`, `stats_source='ncaa_projection'`
- Create `rookie_overrides.json` config file (empty to start)
- **Stop. Show me the projected top 10 rookies — sanity check that Fudd, Miles, Betts, Fam Thiam look reasonable.**

**Checkpoint 4 — Value score + best-available view**
- Implement the z-score value calculation as a backend endpoint, with rookie discount logic
- Build the read-only "Best Available" view with filters, search, injury + rookie badges, value score column
- Sanity-check: top 10 should look roughly like consensus WNBA fantasy rankings (e.g., A'ja Wilson, Breanna Stewart, Caitlin Clark, Alyssa Thomas types should be near the top, with maybe 1–2 elite rookies sprinkled in)
- **Stop. Let me eyeball the rankings before we go further.**

**Checkpoint 5 — Draft board**
- Team setup screen: configurable team count (default 8, support any number from 2–16), enter team names, set snake order. Must be editable up until the draft starts.
- Click-to-draft flow with multi-position slot selection
- Undo stack
- My Team / Other Teams panels with positional slot tracking
- Live category strength projection
- Rookie override editor
- CSV export
- **Stop. I'll do a dry-run mock draft to find UX issues.**

**Checkpoint 6 — Polish for Saturday**
- Whatever rough edges the dry-run surfaced
- Mobile-responsive check (I might want to glance at it on my phone)
- Make sure refresh-data won't blow away an in-progress draft

## Phase 2 (post-May 8, do not build now — just leave hooks)

For later: in-season stat refresh, transaction logging with backdating, rotisserie scoreboard, free-agent finder with rolling z-scores, drop-candidate flagger, transaction simulator, injury alerts via Discord webhook, **rookie projection → actual stat replacement** (once a rookie has ~10 WNBA games, switch their `stats_source` from `ncaa_projection` to `wnba_actual` and use real numbers). Build the schema now to support these (especially the `transactions` table with `effective_date` and the `stats_source` field), but don't build the UI yet.

**Mid-season team changes:** if a team drops out, their roster dissolves into free agency and stops accruing stats for that team. The `transactions` table with `effective_date` already supports this cleanly — a "team_dissolved" transaction type marks the date. Add a TODO comment in the schema for future-me, but don't build the UI now.

**Rookie projection backtest:** the translation multipliers in `projections.py` are best-guess. A backtest against 2024 rookies (project from 2023–24 NCAA stats, compare to actual 2024 WNBA output, tune) is worth doing post-draft if we want confidence. Add as a Phase 2 task.

## Key Gotchas

- **Team count is dynamic, not hardcoded.** Snake order generation, rotisserie scoring (rank 1–N where N = team count, lowest total wins), and roster/standings UI must all derive from the actual team count, not a magic number 8. The DB schema should treat teams as a normal entity — no `team_1` through `team_8` columns, just rows.
- **Rotowire stats table is JS-loaded.** Don't waste time on `requests` + `BeautifulSoup` against the rendered page — find the underlying JSON endpoint via browser dev tools first.
- **Dual-position players** (e.g., Rebecca Allen = "Forward-Guard") must be storable as multiple positions. Single-position-string schema will bite us.
- **Injury status discounts the value score**, but we should still display these players — just with the 🔴 badge so I can make an informed call. Don't filter them out.
- **Rookie projections are estimates, not facts.** Always render the 🆕 badge. Translation multipliers live in a config file, not hardcoded — they'll need tuning. Manual overrides exist for a reason; expose them in the UI.
- **Be respectful of the scrape targets.** Cache, rate-limit, real User-Agent. We're going to use these every day for 5 months.
- **Never destructive on data refresh.** Stat refreshes update existing records; they never wipe the rosters or transactions tables.

## How I Want to Work

- Stop at each checkpoint above and let me review before continuing.
- When you have a real choice to make (e.g., "Rotowire JSON endpoint isn't obvious — should I use Playwright or fall back to BBR?"), ask me. Don't guess on architectural decisions.
- Keep a running `NOTES.md` of decisions made and known issues — I'll be using this for 5 months and will forget context.
- Commit after each checkpoint with a clear message.

Let's start with Checkpoint 1. Set up the project scaffold and the database schema, wire up a hello-world API call, and stop there.