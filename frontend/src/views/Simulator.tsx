import { useEffect, useMemo, useState } from 'react'
import {
  fetchDraftState,
  fetchPlayers,
  postSimulatorPickup,
  type Cat,
  type DraftState,
  type Player,
  type SimulatorResponse,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'
import { AuthChip } from '../components/AuthChip'

// CP11 — drop-rostered + add-FA simulator. Attribution model is
// all-season retroactive: the simulator pretends the swap was in place
// from day 1, sums each team's current roster (after swap, for the
// picking team) over all 2026 game_stats, and re-ranks. The "before"
// baseline diverges from the live scoreboard for any team that has
// executed a backdated trade — by design; before/after stay
// directly comparable and the framing matches "would I be better off
// going forward?".

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToPlayers: () => void
  onSwitchToStrategy: () => void
  onSwitchToTrends: () => void
}

const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

function fmtRank(r: number): string {
  // 1.5 -> "1.5"; 4 -> "4"
  return r % 1 === 0 ? String(r) : r.toFixed(1)
}

function fmtDelta(delta: number, betterIsLower: boolean): {
  text: string
  tone: string
} {
  if (delta === 0) return { text: '0', tone: 'text-slate-500 dark:text-slate-400' }
  const sign = delta > 0 ? '+' : ''
  // For rank/standing/rank_sum: lower is better, so a NEGATIVE delta is good.
  // For cat totals: higher is better, so a POSITIVE delta is good.
  const isImprovement = betterIsLower ? delta < 0 : delta > 0
  const tone = isImprovement
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-red-700 dark:text-red-400'
  const num = Number.isInteger(delta) ? String(delta) : delta.toFixed(2)
  return { text: `${sign}${num}`, tone }
}

export function Simulator({
  onSwitchToScoreboard,
  onSwitchToDraft,
  onSwitchToTransactions,
  onSwitchToPlayers,
  onSwitchToStrategy,
  onSwitchToTrends,
}: Props) {
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [allPlayers, setAllPlayers] = useState<Player[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [teamId, setTeamId] = useState<number | null>(null)
  const [dropPid, setDropPid] = useState<number | null>(null)
  const [addPid, setAddPid] = useState<number | null>(null)
  const [faSearch, setFaSearch] = useState('')
  const [faPosFilter, setFaPosFilter] = useState<'ALL' | 'G' | 'F' | 'C'>('ALL')

  const [result, setResult] = useState<SimulatorResponse | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const [d, p] = await Promise.all([
        fetchDraftState(),
        fetchPlayers({ limit: 1000 }),
      ])
      setDraftState(d)
      setAllPlayers(p.players)
      if (teamId === null) {
        const mine = d.teams.find((t) => t.is_my_team)
        setTeamId(mine?.id ?? d.teams[0]?.id ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset selections when team changes
  useEffect(() => {
    setDropPid(null)
    setAddPid(null)
    setResult(null)
  }, [teamId])

  const teamRoster = useMemo(() => {
    if (!allPlayers || teamId === null) return []
    return allPlayers
      .filter((p) => p.drafted_by_team_id === teamId)
      .sort((a, b) => a.value - b.value)  // weakest first, like Roster Health
  }, [allPlayers, teamId])

  const freeAgents = useMemo(() => {
    if (!allPlayers) return []
    let list = allPlayers.filter((p) => p.drafted_by_team_id === null)
    const q = faSearch.toLowerCase().trim()
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q))
    if (faPosFilter !== 'ALL') {
      list = list.filter((p) => p.positions.includes(faPosFilter))
    }
    return [...list].sort((a, b) => b.value - a.value)
  }, [allPlayers, faSearch, faPosFilter])

  const dropPlayer = useMemo(
    () => teamRoster.find((p) => p.player_id === dropPid) ?? null,
    [teamRoster, dropPid],
  )
  const addPlayer = useMemo(
    () => freeAgents.find((p) => p.player_id === addPid) ?? null,
    [freeAgents, addPid],
  )

  const canRun = teamId !== null && dropPid !== null && addPid !== null && !running

  const runSim = async () => {
    if (!canRun || teamId === null || dropPid === null || addPid === null) return
    setRunning(true)
    setError(null)
    try {
      const r = await postSimulatorPickup({
        team_id: teamId,
        drop_player_id: dropPid,
        add_player_id: addPid,
      })
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const reset = () => {
    setDropPid(null)
    setAddPid(null)
    setResult(null)
  }

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Simulator
          </h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Drop a rostered player, add a free agent — see standings impact
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={onSwitchToScoreboard}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Scoreboard
            </button>
            <button
              onClick={onSwitchToPlayers}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Players
            </button>
            <button
              onClick={onSwitchToStrategy}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Strategy
            </button>
            <button
              onClick={onSwitchToTrends}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Trends
            </button>
            <button
              onClick={onSwitchToTransactions}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Transactions
            </button>
            <button
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

      <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-4 pb-12 space-y-4">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Setup card */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-700 dark:text-slate-300">
              Team:
            </label>
            <select
              value={teamId ?? ''}
              onChange={(e) =>
                setTeamId(e.target.value ? Number(e.target.value) : null)
              }
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
            >
              <option value="">— pick a team —</option>
              {draftState?.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.is_my_team ? '★ ' : ''}
                  {t.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void refresh()}
              disabled={busy}
              className="ml-auto text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? '…' : 'Refresh'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Drop column */}
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40">
              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-300">
                Drop (from roster)
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
                {teamRoster.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">
                    Pick a team first.
                  </div>
                )}
                {teamRoster.map((p) => (
                  <label
                    key={p.player_id}
                    className={
                      'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-white dark:hover:bg-slate-900 ' +
                      (dropPid === p.player_id
                        ? 'bg-red-50 dark:bg-red-950/30'
                        : '')
                    }
                  >
                    <input
                      type="radio"
                      name="drop"
                      checked={dropPid === p.player_id}
                      onChange={() => setDropPid(p.player_id)}
                    />
                    <span className="grow">
                      {p.name}
                      <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                        {p.positions.join('/')} · {p.wnba_team ?? '—'}
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">
                      {p.value.toFixed(2)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Add column */}
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40">
              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Add (free agent)
                </span>
                <input
                  type="text"
                  value={faSearch}
                  onChange={(e) => setFaSearch(e.target.value)}
                  placeholder="Search…"
                  className="ml-auto rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs w-32"
                />
                <div className="flex rounded overflow-hidden border border-slate-300 dark:border-slate-700 text-xs">
                  {(['ALL', 'G', 'F', 'C'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setFaPosFilter(p)}
                      className={
                        'px-2 py-1 ' +
                        (faPosFilter === p
                          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                          : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800')
                      }
                    >
                      {p === 'ALL' ? 'All' : p}
                    </button>
                  ))}
                </div>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
                {freeAgents.slice(0, 50).map((p) => (
                  <label
                    key={p.player_id}
                    className={
                      'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-white dark:hover:bg-slate-900 ' +
                      (addPid === p.player_id
                        ? 'bg-emerald-50 dark:bg-emerald-950/30'
                        : '')
                    }
                  >
                    <input
                      type="radio"
                      name="add"
                      checked={addPid === p.player_id}
                      onChange={() => setAddPid(p.player_id)}
                    />
                    <span className="grow">
                      {p.name}
                      <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                        {p.positions.join('/')} · {p.wnba_team ?? '—'}
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">
                      {p.value.toFixed(2)}
                    </span>
                  </label>
                ))}
                {freeAgents.length > 50 && (
                  <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    Showing top 50 — narrow with search to find more.
                  </div>
                )}
                {freeAgents.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">
                    No free agents match the filter.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void runSim()}
              disabled={!canRun}
              className="rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run simulation'}
            </button>
            {(dropPid || addPid || result) && (
              <button
                onClick={reset}
                className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Reset
              </button>
            )}
            {dropPlayer && addPlayer && (
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Drop <strong>{dropPlayer.name}</strong> → Add{' '}
                <strong>{addPlayer.name}</strong>
              </span>
            )}
          </div>
        </div>

        {/* Results */}
        {result && (
          <ResultPanel result={result} />
        )}
      </section>
    </main>
  )
}

function ResultPanel({ result }: { result: SimulatorResponse }) {
  const beforeById = new Map(result.before.teams.map((t) => [t.team_id, t]))
  const afterById = new Map(result.after.teams.map((t) => [t.team_id, t]))
  const picking = afterById.get(result.picking_team_id)
  const pickingBefore = beforeById.get(result.picking_team_id)

  if (!picking || !pickingBefore) {
    return null
  }

  const standingDelta = picking.standing - pickingBefore.standing
  const rankSumDelta = picking.rank_sum - pickingBefore.rank_sum
  const standingFmt = fmtDelta(standingDelta, true)
  const rankSumFmt = fmtDelta(rankSumDelta, true)

  // Other teams whose overall standing moved
  const movers = result.after.teams
    .map((t) => ({
      after: t,
      before: beforeById.get(t.team_id)!,
      delta: t.standing - (beforeById.get(t.team_id)?.standing ?? t.standing),
    }))
    .filter((m) => m.after.team_id !== result.picking_team_id && m.delta !== 0)

  return (
    <div className="space-y-4">
      {/* Picking team summary */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
          {picking.team_name}
          {picking.is_my_team ? ' ★' : ''} — projected impact
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric
            label="Standing"
            before={fmtRank(pickingBefore.standing)}
            after={fmtRank(picking.standing)}
            delta={standingFmt}
            hint="lower = better"
          />
          <Metric
            label="Rank sum"
            before={fmtRank(pickingBefore.rank_sum)}
            after={fmtRank(picking.rank_sum)}
            delta={rankSumFmt}
            hint="sum of 5 cat ranks"
          />
          <Metric
            label="GP basis"
            before={String(pickingBefore.team_games)}
            after={String(picking.team_games)}
            delta={null}
          />
          <Metric
            label="League GP"
            before=""
            after={String(result.league_games_to_date)}
            delta={null}
          />
        </div>

        {/* Per-cat for picking team */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-600 dark:text-slate-300">
              <tr className="text-left">
                <th className="px-2 py-1.5">Cat</th>
                <th className="px-2 py-1.5 text-right">Total before</th>
                <th className="px-2 py-1.5 text-right">Total after</th>
                <th className="px-2 py-1.5 text-right">Δ total</th>
                <th className="px-2 py-1.5 text-right">Rank before</th>
                <th className="px-2 py-1.5 text-right">Rank after</th>
                <th className="px-2 py-1.5 text-right">Δ rank</th>
              </tr>
            </thead>
            <tbody>
              {CATS.map((c) => {
                const b = pickingBefore.cats[c]
                const a = picking.cats[c]
                const totalDelta = a.total - b.total
                const rankDelta = a.rank - b.rank
                const tFmt = fmtDelta(totalDelta, false)
                const rFmt = fmtDelta(rankDelta, true)
                return (
                  <tr
                    key={c}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-2 py-1.5 font-medium text-slate-700 dark:text-slate-300">
                      {CAT_LABEL[c]}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {b.total}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {a.total}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${tFmt.tone}`}>
                      {tFmt.text}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtRank(b.rank)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtRank(a.rank)}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${rFmt.tone}`}>
                      {rFmt.text}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* All teams overview */}
      <AllTeamsTable result={result} />

      {/* Other movers callout */}
      {movers.length > 0 && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <strong>Other teams that shifted:</strong>{' '}
          {movers
            .map((m) => {
              const sign = m.delta > 0 ? '+' : ''
              return `${m.after.team_name} (${sign}${m.delta.toFixed(1)})`
            })
            .join(', ')}
        </div>
      )}
    </div>
  )
}

function Metric({
  label,
  before,
  after,
  delta,
  hint,
}: {
  label: string
  before: string
  after: string
  delta: { text: string; tone: string } | null
  hint?: string
}) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2">
      <div className="text-xs text-slate-500 dark:text-slate-400">
        {label}
        {hint && <span className="ml-1">({hint})</span>}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        {before && (
          <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400 line-through">
            {before}
          </span>
        )}
        <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {after}
        </span>
        {delta && (
          <span className={`text-sm tabular-nums ${delta.tone}`}>
            {delta.text}
          </span>
        )}
      </div>
    </div>
  )
}

function AllTeamsTable({ result }: { result: SimulatorResponse }) {
  const beforeById = new Map(result.before.teams.map((t) => [t.team_id, t]))
  const ordered = result.after.teams.slice() // already sorted by standing asc

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
          <tr className="text-left">
            <th className="px-3 py-2">Team</th>
            <th className="px-3 py-2 text-right">Standing (before → after)</th>
            <th className="px-3 py-2 text-right">Rank sum</th>
            {CATS.map((c) => (
              <th key={c} className="px-3 py-2 text-right">
                {CAT_LABEL[c]} rank
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => {
            const b = beforeById.get(t.team_id)!
            const isPicking = t.team_id === result.picking_team_id
            return (
              <tr
                key={t.team_id}
                className={
                  'border-t border-slate-100 dark:border-slate-800 ' +
                  (isPicking ? 'bg-sky-50 dark:bg-sky-950/30 font-medium' : '')
                }
              >
                <td className="px-3 py-1.5">
                  {t.is_my_team ? '★ ' : ''}
                  {t.team_name}
                  {isPicking && (
                    <span className="ml-2 text-xs rounded bg-sky-200 text-sky-900 dark:bg-sky-900/60 dark:text-sky-200 px-1.5 py-0.5">
                      PICKING
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  <CellPair before={b.standing} after={t.standing} betterIsLower />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  <CellPair before={b.rank_sum} after={t.rank_sum} betterIsLower />
                </td>
                {CATS.map((c) => (
                  <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                    <CellPair
                      before={b.cats[c].rank}
                      after={t.cats[c].rank}
                      betterIsLower
                    />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CellPair({
  before,
  after,
  betterIsLower,
}: {
  before: number
  after: number
  betterIsLower: boolean
}) {
  const same = before === after
  const tone = same
    ? 'text-slate-500 dark:text-slate-400'
    : (after < before) === betterIsLower
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-red-700 dark:text-red-400'
  return (
    <span>
      <span className="text-slate-500 dark:text-slate-400">
        {fmtRank(before)}
      </span>
      <span className="mx-1 text-slate-400">→</span>
      <span className={same ? '' : `font-semibold ${tone}`}>
        {fmtRank(after)}
      </span>
    </span>
  )
}
