import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  fetchDraftState,
  fetchStandings,
  fetchSyncStatus,
  fetchTransactions,
  fetchTrends,
  type Cat,
  type DraftState,
  type StandingsResponse,
  type StandingsTeam,
  type SyncStatus,
  type TransactionsResponse,
  type TrendsResponse,
  type TxnEvent,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'

// Spectator view is the polished public dashboard at /spectator. It's
// shared with non-league friends via the Tailscale Funnel URL, so the
// header intentionally omits owner-only affordances (sign-in, sync, draft,
// transactions form). Everything here calls public read-only endpoints.

const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

const TEAM_COLORS = [
  '#dc2626', '#2563eb', '#16a34a', '#ca8a04',
  '#9333ea', '#0891b2', '#ea580c', '#db2777',
]

function teamColor(draftSlot: number): string {
  return TEAM_COLORS[(draftSlot - 1) % TEAM_COLORS.length]
}

function formatRank(rank: number): string {
  return Number.isInteger(rank) ? rank.toString() : rank.toFixed(1)
}

function formatTickDate(s: string): string {
  const [, m, d] = s.split('-')
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]
  return `${month} ${Number(d)}`
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function summarizeEvent(ev: TxnEvent): string {
  if (ev.event_type === 'pickup') {
    const drop = ev.legs.find((l) => l.transaction_type === 'drop')
    const add = ev.legs.find((l) => l.transaction_type === 'add')
    const team = drop?.from_team_name ?? add?.to_team_name ?? '?'
    return `${team}: drop ${drop?.player_name ?? '?'}, add ${add?.player_name ?? '?'}`
  }
  if (ev.event_type === 'trade') {
    const a = ev.legs[0]
    const b = ev.legs[1]
    return `${a?.from_team_name ?? '?'} ↔ ${b?.from_team_name ?? '?'}: ${a?.player_name ?? '?'} for ${b?.player_name ?? '?'}`
  }
  return ev.legs.map((l) => `${l.transaction_type} ${l.player_name}`).join(', ')
}

type TeamOrder = {
  name: string
  draft_slot: number
  is_my_team: boolean
}

type FlatPoint = Record<string, string | number>

function flattenStanding(trends: TrendsResponse): FlatPoint[] {
  return trends.days.map((d) => {
    const point: FlatPoint = { date: d.date }
    for (const [tid, snap] of Object.entries(d.teams)) {
      const name = trends.team_names[tid]
      point[name] = snap.standing
    }
    return point
  })
}

function StandingsTable({
  data,
}: {
  data: StandingsResponse
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="overflow-x-auto rounded">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
            <tr className="text-left">
              <th className="px-3 py-2 w-12 text-right">#</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2 w-16 text-right">Σ rank</th>
              <th className="px-3 py-2 w-12 text-right">GP</th>
              {CATS.map((c) => (
                <th key={c} className="px-3 py-2 w-24 text-right">
                  {CAT_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.teams.map((t: StandingsTeam) => (
              <tr
                key={t.team_id}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                  {formatRank(t.standing)}
                </td>
                <td className="px-3 py-2">{t.team_name}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {formatRank(t.rank_sum)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {t.games_played}
                </td>
                {CATS.map((c) => {
                  const cl = t.cats[c]
                  return (
                    <td
                      key={c}
                      className="px-3 py-2 text-right tabular-nums"
                    >
                      <span className="text-slate-900 dark:text-slate-100">
                        {cl.total}
                      </span>
                      <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                        #{formatRank(cl.rank)}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StandingTrendChart({
  trends,
  teamOrder,
}: {
  trends: TrendsResponse
  teamOrder: TeamOrder[]
}) {
  const data = useMemo(() => flattenStanding(trends), [trends])
  const numTeams = teamOrder.length || 8

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold">Standing over time</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          lower = better · 1 = league leader
        </span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} />
          <XAxis
            dataKey="date"
            tickFormatter={formatTickDate}
            stroke="currentColor"
            fontSize={11}
          />
          <YAxis
            reversed
            domain={[1, numTeams]}
            allowDecimals={false}
            stroke="currentColor"
            fontSize={11}
          />
          <Tooltip
            contentStyle={{
              background: 'rgb(15 23 42 / 0.95)',
              border: '1px solid rgb(51 65 85)',
              borderRadius: 6,
              fontSize: 12,
              color: 'rgb(241 245 249)',
            }}
            labelFormatter={(label) => formatTickDate(String(label))}
          />
          {teamOrder.map((t) => (
            <Line
              key={t.name}
              type="monotone"
              dataKey={t.name}
              stroke={teamColor(t.draft_slot)}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs">
        {teamOrder.map((t) => (
          <span key={t.name} className="inline-flex items-center gap-1">
            <span
              className="inline-block w-3 h-0.5"
              style={{ background: teamColor(t.draft_slot) }}
            />
            <span>{t.name}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function RecentMoves({ data }: { data: TransactionsResponse }) {
  // Latest first — sort by effective_date desc, then created_at desc as a tiebreaker.
  const events = [...data.events]
    .sort((a, b) => {
      if (a.effective_date !== b.effective_date) {
        return a.effective_date < b.effective_date ? 1 : -1
      }
      return a.created_at < b.created_at ? 1 : -1
    })
    .slice(0, 10)

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200">
        Recent moves
      </div>
      {events.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          No transactions yet this season.
        </div>
      ) : (
        <ul>
          {events.map((ev) => (
            <li
              key={ev.event_id}
              className="flex items-center gap-3 px-3 py-2 border-t border-slate-100 dark:border-slate-800 first:border-t-0"
            >
              <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400 w-24 shrink-0">
                {ev.effective_date}
              </span>
              <span className="text-sm text-slate-900 dark:text-slate-100">
                {summarizeEvent(ev)}
                {ev.note && (
                  <span className="ml-2 text-xs italic text-slate-500 dark:text-slate-400">
                    "{ev.note}"
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Spectator() {
  const [standings, setStandings] = useState<StandingsResponse | null>(null)
  const [trends, setTrends] = useState<TrendsResponse | null>(null)
  const [transactions, setTransactions] = useState<TransactionsResponse | null>(null)
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setError(null)
    try {
      const [s, t, tx, d, sy] = await Promise.all([
        fetchStandings(2026),
        fetchTrends(2026),
        fetchTransactions(),
        fetchDraftState(),
        fetchSyncStatus(),
      ])
      setStandings(s)
      setTrends(t)
      setTransactions(tx)
      setDraftState(d)
      setSync(sy)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const teamOrder: TeamOrder[] = useMemo(() => {
    if (!draftState) return []
    return [...draftState.teams]
      .sort((a, b) => a.draft_slot - b.draft_slot)
      .map((t) => ({ name: t.name, draft_slot: t.draft_slot, is_my_team: t.is_my_team }))
  }, [draftState])

  const lastSyncLabel = sync?.last_completed_at
    ? formatSyncTime(sync.last_completed_at)
    : sync?.started_at
    ? `syncing (started ${formatSyncTime(sync.started_at)})`
    : 'never'

  const gamesNote = standings
    ? `league at ${standings.league_games_to_date} of ${standings.full_season_games} games`
    : null

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              WNBA Fantasy 2026
            </h1>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              Spectator view{gamesNote ? ` · ${gamesNote}` : ''}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Last update: {lastSyncLabel}
              </span>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-6 pb-12 space-y-6">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {loading && !error && (
          <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
        )}

        {standings && (
          <div>
            <h2 className="text-sm font-semibold mb-2 text-slate-700 dark:text-slate-200">
              Standings
            </h2>
            <StandingsTable data={standings} />
            {standings.league_games_to_date === 0 && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Pre-season — every team starts at 0. Standings populate as games are played.
              </p>
            )}
          </div>
        )}

        {trends && trends.days.length > 0 && (
          <StandingTrendChart trends={trends} teamOrder={teamOrder} />
        )}

        {transactions && <RecentMoves data={transactions} />}

        <footer className="pt-4 text-xs text-slate-400 dark:text-slate-600">
          Read-only spectator view · data refreshes daily at 6am Pacific
        </footer>
      </section>
    </main>
  )
}
