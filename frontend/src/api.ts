const buildQuery = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

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
  factors: {
    availability: number
    position: number
    injury: number
    rookie: number
  }
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
}

export const fetchPlayers = (q: PlayersQuery = {}) =>
  apiFetch<PlayersResponse>(`/api/players${buildQuery(q)}`)
