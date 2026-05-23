import { AdminAuthError, clearToken, getToken } from './auth'

const buildQuery = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Attach admin token if signed in. Public reads still work without it;
  // the backend gate only fires on write routes.
  const token = getToken()
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['X-Admin-Token'] = token

  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      // not JSON, ignore
    }
    // 401 means token is missing/wrong — drop the stale token so the UI
    // re-prompts. Throw a typed error so views can distinguish.
    if (res.status === 401) {
      clearToken()
      throw new AdminAuthError(detail)
    }
    throw new Error(`${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

const apiPost = <T>(path: string, body: unknown) =>
  apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const apiDelete = <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' })

export type Health = {
  status: string
  db_connected: boolean
  player_count: number
}

export type Player = {
  player_id: number
  name: string
  positions: string[]
  wnba_team: string | null
  is_rookie: boolean
  draft_pick: number | null
  school: string | null
  projected_mpg: number | null
  override_note: string | null
  stats_source: 'wnba_actual' | 'ncaa_projection'
  injury_status: string | null
  injury_description: string | null
  injury_return_date: string | null  // ISO 'YYYY-MM-DD'
  drafted_by_team_id: number | null
  totals: {
    games_played: number
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
  }
  // 2026 actuals summed from game_stats. Parallel to `totals` (which may
  // still be 2025-basis until the player crosses the 10-GP threshold).
  season_totals: {
    games_played: number
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
  }
  // 2026 production projects materially above value basis — surfaces
  // breakout candidates whose role/usage has changed (Sabally, Carleton,
  // etc.) before they cross the 10-GP cutover.
  is_hot: boolean
  z_scores: {
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
  }
  value: number
  raw_value: number
  marginal_value: number | null
  strategy_weighted_value: number | null
  factors: {
    availability: number
    position: number
    injury: number
    rookie: number
  }
}

export type CatPaceInfo = {
  current: number
  target_end_of_draft: number
  expected_so_far: number
  ratio: number | null
}

export type TeamCatStatus = {
  totals: Record<'points' | 'rebounds' | 'assists' | 'steals' | 'blocks', number>
  by_cat: Record<'points' | 'rebounds' | 'assists' | 'steals' | 'blocks', CatPaceInfo>
}

export type Slot = 'G' | 'F' | 'C' | 'UTIL'

export type RosterEntry = {
  roster_id: number
  team_id: number
  player_id: number
  slot: Slot
  drafted_round: number | null
  drafted_overall_pick: number | null
  player: {
    id: number
    name: string
    positions: string[]
    wnba_team: string | null
    is_rookie: boolean
    draft_pick: number | null
  }
}

export type TeamSummary = {
  id: number
  name: string
  draft_slot: number
  is_my_team: boolean
}

export type DraftState = {
  teams: TeamSummary[]
  rosters: RosterEntry[]
  picks_made: number
  total_picks: number
  on_the_clock: {
    team_id: number
    team_name: string
    round: number
    draft_slot: number
    overall_pick: number
  } | null
  is_complete: boolean
  roster_shape: Record<Slot, number>
  pace_targets: Record<'points' | 'rebounds' | 'assists' | 'steals' | 'blocks', number>
  team_cat_status: Record<string, TeamCatStatus>  // team_id (as string) -> status
}

export type TeamSetupItem = {
  name: string
  draft_slot: number
  is_my_team?: boolean
}

export type PlayersResponse = {
  count: number
  for_team_id: number | null
  strategic_team_id: number | null
  strategy_weights: Record<string, number> | null
  players: Player[]
}

export type PlayersQuery = {
  search?: string
  position?: 'G' | 'F' | 'C'
  hide_rookies?: boolean
  rookies_only?: boolean
  limit?: number
  for_team_id?: number
  strategic_team_id?: number
}

export const fetchPlayers = (q: PlayersQuery = {}) =>
  apiFetch<PlayersResponse>(`/api/players${buildQuery(q)}`)

export const fetchDraftState = () => apiFetch<DraftState>('/api/draft/state')

export const setupTeams = (teams: TeamSetupItem[], force = false) =>
  apiPost<{ teams: TeamSummary[] }>('/api/teams/setup', { teams, force })

export const resetDraft = (force = false) =>
  apiDelete<{ status: string; wiped_picks: number }>(
    `/api/teams${force ? '?force=true' : ''}`,
  )

export const makePick = (player_id: number, team_id?: number) =>
  apiPost<DraftState>('/api/draft/pick', { player_id, team_id })

export const undoLastPick = () => apiDelete<DraftState>('/api/draft/pick/last')

export const draftCsvUrl = '/api/draft/csv'

// ---- Standings (CP8) ----

export type Cat = 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks'

export type StandingsCatLine = {
  total: number
  rank: number       // tie-aware (e.g. 4.5 when all teams tied at 0)
  projected: number  // linear-pace extrapolation to full season
}

export type StandingsPlayer = {
  player_id: number
  name: string
  positions: string[]
  wnba_team: string | null
  is_rookie: boolean
  games: number
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  injury_status: string | null
  is_current_roster: boolean   // false = traded-away player whose pre-trade
                                // stats still attribute to this team
}

export type StandingsTeam = {
  team_id: number
  team_name: string
  is_my_team: boolean
  draft_slot: number
  games_played: number  // max GP across this team's roster
  rank_sum: number      // sum of 5 cat ranks, lower = better
  standing: number      // 1..N tie-aware overall place
  cats: Record<Cat, StandingsCatLine>
  players: StandingsPlayer[]
}

export type StandingsResponse = {
  season: number
  league_games_to_date: number
  full_season_games: number
  computed_at: string
  teams: StandingsTeam[]
}

export const fetchStandings = (season = 2026) =>
  apiFetch<StandingsResponse>(`/api/standings?season=${season}`)

// ---- Trends (per-day league snapshots for chart view) ----

export type TrendsTeamDay = {
  standing: number
  rank_sum: number
  cats: Record<Cat, number>
}

export type TrendsDay = {
  date: string            // ISO YYYY-MM-DD
  teams: Record<string, TrendsTeamDay>   // team_id (string) -> day snapshot
}

export type TrendsResponse = {
  season: number
  computed_at: string
  team_names: Record<string, string>     // team_id (string) -> team name
  days: TrendsDay[]
}

export const fetchTrends = (season = 2026) =>
  apiFetch<TrendsResponse>(`/api/trends?season=${season}`)

// ---- Transactions (CP9) ----

export type TxnCategory = 'strategic' | 'injury'

export type TxnLeg = {
  transaction_type: 'add' | 'drop' | 'trade'
  player_id: number | null
  player_name: string | null
  from_team_id: number | null
  from_team_name: string | null
  to_team_id: number | null
  to_team_name: string | null
}

export type TxnEvent = {
  event_id: string
  event_type: 'pickup' | 'trade' | string
  category: TxnCategory | null
  effective_date: string  // ISO YYYY-MM-DD
  created_at: string
  note: string | null
  teams_involved: number[]
  legs: TxnLeg[]
}

export type TxnUsage = {
  team_id: number
  team_name: string | null
  strategic_used: number
  injury_used: number
  total_used: number
  strategic_remaining: number
  injury_remaining: number
  total_remaining: number
}

export type TxnLimits = {
  per_team: number
  strategic_per_team: number
  injury_per_team: number
}

export type TransactionsResponse = {
  events: TxnEvent[]
  usage: TxnUsage[]
  limits: TxnLimits
}

export const fetchTransactions = () =>
  apiFetch<TransactionsResponse>('/api/transactions')

export const postPickup = (body: {
  team_id: number
  add_player_id: number
  drop_player_id: number
  effective_date?: string  // ISO date
  category: TxnCategory
  note?: string
}) => apiPost<{ event_id: string }>('/api/transactions/pickup', body)

export const postTrade = (body: {
  team_a_id: number
  team_a_player_id: number
  team_b_id: number
  team_b_player_id: number
  effective_date?: string
  category: TxnCategory
  note?: string
}) => apiPost<{ event_id: string }>('/api/transactions/trade', body)

export const undoTransaction = (event_id: string) =>
  apiDelete<{ deleted_rows: number; event_id: string }>(`/api/transactions/${event_id}`)

// ---- Simulator (CP11) ----

export type SimCatLine = {
  total: number
  rank: number
  projected: number
}

export type SimTeam = {
  team_id: number
  team_name: string
  is_my_team: boolean
  draft_slot: number
  rank_sum: number
  standing: number
  team_games: number
  cats: Record<Cat, SimCatLine>
}

export type SimWorld = {
  teams: SimTeam[]
}

export type SimulatorResponse = {
  season: number
  full_season_games: number
  league_games_to_date: number
  picking_team_id: number
  drop_player_id: number
  drop_player_name: string
  add_player_id: number
  add_player_name: string
  before: SimWorld
  after: SimWorld
}

export const postSimulatorPickup = (body: {
  team_id: number
  drop_player_id: number
  add_player_id: number
}) => apiPost<SimulatorResponse>('/api/simulator/pickup', body)

// ---- Strategy (CP13) ----

export type Classification = 'lock' | 'contend' | 'punt'

export type CatStrategy = {
  cat: Cat
  current_total: number
  current_rank: number
  projected_total: number
  projected_rank: number
  gap_up: number | null      // my_projected - team_above_projected; null if #1
  gap_down: number | null    // my_projected - team_below_projected; null if last
  classification: Classification
  weight: number
}

export type H2HCatLine = {
  cat: Cat
  my_total: number
  opp_total: number
  current_gap: number
  my_projected: number
  opp_projected: number
  projected_gap: number
  status: 'winning' | 'tied' | 'losing'
}

export type HeadToHead = {
  opp_team_id: number
  opp_team_name: string
  opp_rank_sum: number
  opp_standing: number
  cats_winning: number
  cats_losing: number
  cats_tied: number
  cats: H2HCatLine[]
}

export type StrategyResponse = {
  team_id: number
  team_name: string
  is_my_team: boolean
  team_games_played: number
  avg_team_games: number
  low_sample: boolean
  rank_sum: number
  standing: number
  cats: CatStrategy[]
  head_to_head: HeadToHead[]
}

export const fetchStrategy = (team_id: number, season = 2026) =>
  apiFetch<StrategyResponse>(`/api/strategy?team_id=${team_id}&season=${season}`)

// --- Data sync (BBR gamelogs + ESPN injuries) -------------------------------

export type SyncStatus = {
  running: boolean
  started_at: string | null  // ISO 8601 UTC
  progress: string | null
  last_completed_at: string | null
  last_summary: {
    season?: number
    injuries?: { fetched: number; inserted: number; updated: number; unlinked: number; deleted_stale: number }
    gamelogs?: { players: number; games_scraped: number; inserted: number; updated: number; empty_players: number; errors: number }
  }
  last_error: string | null
  season: number
}

export const fetchSyncStatus = () => apiFetch<SyncStatus>('/api/refresh/status')

export const triggerSync = () => apiPost<SyncStatus>('/api/refresh', {})
