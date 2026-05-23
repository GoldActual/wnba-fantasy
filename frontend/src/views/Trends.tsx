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
  fetchTrends,
  type Cat,
  type DraftState,
  type TrendsResponse,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'
import { AuthChip } from '../components/AuthChip'

const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

// Eight distinct colors so each team's line is identifiable. Chose hex
// instead of Tailwind classes because recharts wants raw color strings.
// Order matches team draft_slot; the user's team gets emphasis via stroke
// width, not a different color, so charts stay readable in screenshots
// shared with the league.
const TEAM_COLORS = [
  '#dc2626', // red-600
  '#2563eb', // blue-600
  '#16a34a', // green-600
  '#ca8a04', // yellow-600
  '#9333ea', // purple-600
  '#0891b2', // cyan-600
  '#ea580c', // orange-600
  '#db2777', // pink-600
]

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToPlayers: () => void
  onSwitchToSimulator: () => void
  onSwitchToStrategy: () => void
}

// Recharts wants a flat array of points where each point has all line
// values keyed by series name. Pre-shape the API response into that.
// `date` lives next to the per-team numbers; recharts handles the mixed
// shape fine as long as the dataKey accessors don't read 'date' as a
// numeric series.
type FlatPoint = Record<string, string | number>

function flatten(
  trends: TrendsResponse,
  metric: 'standing' | 'rank_sum' | Cat,
): FlatPoint[] {
  return trends.days.map((d) => {
    const point: FlatPoint = { date: d.date }
    for (const [tid, snap] of Object.entries(d.teams)) {
      const name = trends.team_names[tid]
      if (metric === 'standing') point[name] = snap.standing
      else if (metric === 'rank_sum') point[name] = snap.rank_sum
      else point[name] = snap.cats[metric]
    }
    return point
  })
}

function teamColor(draftSlot: number): string {
  return TEAM_COLORS[(draftSlot - 1) % TEAM_COLORS.length]
}

// Compact date label for x-axis ticks. "May 8" / "May 22".
function formatTickDate(s: string): string {
  const [, m, d] = s.split('-')
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]
  return `${month} ${Number(d)}`
}

type TeamOrder = {
  name: string
  draft_slot: number
  is_my_team: boolean
}

function TrendLineChart({
  data,
  teams,
  yLabel,
  yDomain,
  yReversed,
  yAllowDecimals,
  height = 280,
}: {
  data: FlatPoint[]
  teams: TeamOrder[]
  yLabel: string
  yDomain?: [number | 'auto', number | 'auto']
  yReversed?: boolean
  yAllowDecimals?: boolean
  height?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid stroke="currentColor" strokeOpacity={0.1} />
        <XAxis
          dataKey="date"
          tickFormatter={formatTickDate}
          stroke="currentColor"
          fontSize={11}
        />
        <YAxis
          reversed={yReversed}
          domain={yDomain}
          allowDecimals={yAllowDecimals}
          stroke="currentColor"
          fontSize={11}
          label={{
            value: yLabel,
            angle: -90,
            position: 'insideLeft',
            style: { fontSize: 11, fill: 'currentColor' },
          }}
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
        {teams.map((t) => (
          <Line
            key={t.name}
            type="monotone"
            dataKey={t.name}
            stroke={teamColor(t.draft_slot)}
            strokeWidth={t.is_my_team ? 3 : 1.5}
            strokeDasharray={t.is_my_team ? undefined : '0'}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function Trends({
  onSwitchToScoreboard,
  onSwitchToDraft,
  onSwitchToTransactions,
  onSwitchToPlayers,
  onSwitchToSimulator,
  onSwitchToStrategy,
}: Props) {
  const [trends, setTrends] = useState<TrendsResponse | null>(null)
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const [t, d] = await Promise.all([fetchTrends(2026), fetchDraftState()])
      setTrends(t)
      setDraftState(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Stable team order (draft_slot ascending), so colors match across all
  // charts and lines render in a consistent z-order.
  const teamOrder: TeamOrder[] = useMemo(() => {
    if (!draftState) return []
    return [...draftState.teams]
      .sort((a, b) => a.draft_slot - b.draft_slot)
      .map((t) => ({ name: t.name, draft_slot: t.draft_slot, is_my_team: t.is_my_team }))
  }, [draftState])

  const standingData = useMemo(
    () => (trends ? flatten(trends, 'standing') : []),
    [trends],
  )
  const rankSumData = useMemo(
    () => (trends ? flatten(trends, 'rank_sum') : []),
    [trends],
  )
  const catData: Record<Cat, FlatPoint[]> = useMemo(() => {
    const out = {} as Record<Cat, FlatPoint[]>
    for (const c of CATS) out[c] = trends ? flatten(trends, c) : []
    return out
  }, [trends])

  const numTeams = teamOrder.length || 8

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Trends</h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {trends
              ? `Season ${trends.season} · ${trends.days.length} day${
                  trends.days.length === 1 ? '' : 's'
                } of data · your team in bold`
              : 'loading…'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={busy}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? '…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={onSwitchToScoreboard}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Scoreboard
            </button>
            <button
              type="button"
              onClick={onSwitchToPlayers}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Players
            </button>
            <button
              type="button"
              onClick={onSwitchToStrategy}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Strategy
            </button>
            <button
              type="button"
              onClick={onSwitchToSimulator}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Simulator
            </button>
            <button
              type="button"
              onClick={onSwitchToTransactions}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Transactions
            </button>
            <button
              type="button"
              onClick={onSwitchToDraft}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Draft board
            </button>
            <SyncButton onSyncComplete={() => void refresh()} />
            <AuthChip />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-4 pb-12 space-y-6">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {trends && trends.days.length === 0 && (
          <div className="rounded-md bg-slate-100 dark:bg-slate-800/40 px-4 py-6 text-center text-sm text-slate-600 dark:text-slate-400">
            No games played yet — trends start populating once 2026 games are ingested.
          </div>
        )}

        {trends && trends.days.length > 0 && (
          <>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-baseline justify-between mb-1">
                <h2 className="text-sm font-semibold">Overall standing</h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  lower = better · 1 = league leader
                </span>
              </div>
              <TrendLineChart
                data={standingData}
                teams={teamOrder}
                yLabel="standing"
                yDomain={[1, numTeams]}
                yReversed
                yAllowDecimals={false}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs">
                {teamOrder.map((t) => (
                  <span key={t.name} className="inline-flex items-center gap-1">
                    <span
                      className="inline-block w-3 h-0.5"
                      style={{ background: teamColor(t.draft_slot) }}
                    />
                    <span className={t.is_my_team ? 'font-semibold' : ''}>
                      {t.is_my_team ? '★ ' : ''}{t.name}
                    </span>
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-baseline justify-between mb-1">
                <h2 className="text-sm font-semibold">Rank sum</h2>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  sum of 5 cat ranks · lower = better
                </span>
              </div>
              <TrendLineChart
                data={rankSumData}
                teams={teamOrder}
                yLabel="Σ rank"
                yReversed
                yAllowDecimals={false}
              />
            </div>

            <div>
              <h2 className="text-sm font-semibold mb-2">By category (cumulative totals)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {CATS.map((c) => (
                  <div
                    key={c}
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <h3 className="text-xs font-semibold uppercase tracking-wide">
                        {CAT_LABEL[c]}
                      </h3>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">
                        higher = better
                      </span>
                    </div>
                    <TrendLineChart
                      data={catData[c]}
                      teams={teamOrder}
                      yLabel=""
                      yAllowDecimals={false}
                      height={180}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
