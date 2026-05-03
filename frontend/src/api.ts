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
  const res = await fetch(path, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      // not JSON, ignore
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
  players: Player[]
}

export type PlayersQuery = {
  search?: string
  position?: 'G' | 'F' | 'C'
  hide_rookies?: boolean
  rookies_only?: boolean
  limit?: number
  for_team_id?: number
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
