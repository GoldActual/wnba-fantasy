import { useEffect, useMemo, useState } from 'react'
import {
  fetchDraftState,
  fetchStrategy,
  type Cat,
  type Classification,
  type DraftState,
  type StrategyResponse,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'

// CP13 — cat-targeting strategy. Classifies each cat as Lock / Contend /
// Punt and surfaces head-to-head deltas vs every other team. The point
// in a 4-transaction-per-season rotis league: identify the 1-2 cats to
// punt and the 3-4 to overweight, so the next pickup actually moves the
// needle on standing.

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToPlayers: () => void
  onSwitchToSimulator: () => void
}

const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

const CLASS_LABEL: Record<Classification, string> = {
  lock: 'Lock',
  contend: 'Contend',
  punt: 'Punt',
}

const CLASS_TONE: Record<Classification, string> = {
  lock: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  contend: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300 border-sky-200 dark:border-sky-900',
  punt: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 border-amber-200 dark:border-amber-900',
}

function formatRank(r: number): string {
  return Number.isInteger(r) ? r.toString() : r.toFixed(1)
}

function fmtSignedNum(n: number | null, decimals = 0): string {
  if (n === null) return '—'
  if (n === 0) return '0'
  const sign = n > 0 ? '+' : ''
  return `${sign}${decimals === 0 ? Math.round(n) : n.toFixed(decimals)}`
}

// Tone for a signed number where bigger=better for cat totals (positive=green).
function signedTone(n: number | null): string {
  if (n === null || n === 0) return 'text-slate-500 dark:text-slate-400'
  return n > 0
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-red-700 dark:text-red-400'
}

// Tone for a rank delta (lower rank = better, so positive delta is bad).
function rankDeltaTone(n: number | null): string {
  if (n === null || n === 0) return 'text-slate-500 dark:text-slate-400'
  return n < 0
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-red-700 dark:text-red-400'
}

export function Strategy({
  onSwitchToScoreboard,
  onSwitchToDraft,
  onSwitchToTransactions,
  onSwitchToPlayers,
  onSwitchToSimulator,
}: Props) {
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [data, setData] = useState<StrategyResponse | null>(null)
  const [teamId, setTeamId] = useState<number | null>(null)
  const [oppId, setOppId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadTeams = async () => {
    setError(null)
    try {
      const d = await fetchDraftState()
      setDraftState(d)
      if (teamId === null) {
        const mine = d.teams.find((t) => t.is_my_team)
        setTeamId(mine?.id ?? d.teams[0]?.id ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const refresh = async () => {
    if (teamId === null) return
    setBusy(true)
    setError(null)
    try {
      const s = await fetchStrategy(teamId, 2026)
      setData(s)
      // Default opponent to the team currently ranked just above us if any,
      // else just above otherwise the first one in the list.
      if (oppId === null || !s.head_to_head.some((h) => h.opp_team_id === oppId)) {
        const justAbove = s.head_to_head.find((h) => h.opp_standing < s.standing)
        setOppId(justAbove?.opp_team_id ?? s.head_to_head[0]?.opp_team_id ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void loadTeams()
  }, [])

  useEffect(() => {
    if (teamId !== null) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  // When the user switches teams, reset the opponent so we re-pick the
  // "just above" default on the next refresh.
  const onTeamChange = (id: number) => {
    setTeamId(id)
    setOppId(null)
  }

  const opp = useMemo(
    () => data?.head_to_head.find((h) => h.opp_team_id === oppId) ?? null,
    [data, oppId],
  )

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Strategy</h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Cat-targeting forecast · which cats to push, which to punt
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
              onClick={onSwitchToSimulator}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Simulator
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

        {/* Team picker */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 flex flex-wrap items-center gap-3">
          <label className="text-sm text-slate-700 dark:text-slate-300">
            Analyze team:
          </label>
          <select
            value={teamId ?? ''}
            onChange={(e) => onTeamChange(Number(e.target.value))}
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
          {data && (
            <span className="text-sm text-slate-600 dark:text-slate-400">
              Standing <strong>{formatRank(data.standing)}</strong> · Σ rank{' '}
              <strong>{formatRank(data.rank_sum)}</strong> · {data.team_games_played} GP
              {' '}(league avg {data.avg_team_games})
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={busy || teamId === null}
            className="ml-auto text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? '…' : 'Refresh'}
          </button>
        </div>

        {data?.low_sample && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
            <strong>Low sample size:</strong> teams have played an average of{' '}
            {data.avg_team_games} games. Classifications are derived from a small
            number of games and will shift as the season progresses — read with
            caution before burning a transaction.
          </div>
        )}

        {/* Standings forecast */}
        {data && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200">
              Standings forecast — {data.is_my_team ? '★ ' : ''}
              {data.team_name}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
                  <tr className="text-left">
                    <th className="px-3 py-2">Cat</th>
                    <th className="px-3 py-2 text-right">Now</th>
                    <th className="px-3 py-2 text-right">Proj</th>
                    <th className="px-3 py-2 text-right">Rank now → proj</th>
                    <th className="px-3 py-2 text-right">Gap↑</th>
                    <th className="px-3 py-2 text-right">Gap↓</th>
                    <th className="px-3 py-2 text-center">Class</th>
                    <th className="px-3 py-2 text-right">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cats.map((c) => {
                    const rankShift = c.projected_rank - c.current_rank
                    return (
                      <tr
                        key={c.cat}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="px-3 py-2 font-medium">{CAT_LABEL[c.cat]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.current_total}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.projected_total}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="text-slate-500 dark:text-slate-400">
                            {formatRank(c.current_rank)}
                          </span>
                          <span className="mx-1 text-slate-400">→</span>
                          <span className="font-semibold">
                            {formatRank(c.projected_rank)}
                          </span>
                          {rankShift !== 0 && (
                            <span className={`ml-1 text-xs ${rankDeltaTone(rankShift)}`}>
                              ({fmtSignedNum(rankShift, 1)})
                            </span>
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${signedTone(c.gap_up)}`}
                          title="Distance to the team one rank above me (negative = chasing)"
                        >
                          {fmtSignedNum(c.gap_up)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${signedTone(c.gap_down)}`}
                          title="Distance to the team one rank below me (positive = lead)"
                        >
                          {fmtSignedNum(c.gap_down)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${CLASS_TONE[c.classification]}`}
                          >
                            {CLASS_LABEL[c.classification]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                          ×{c.weight.toFixed(1)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              Suggested weights apply to FA value when reweighting by strategy
              (CP14 hook). Lock = ×0.4 (don't waste transactions defending a won
              cat). Contend = ×1.5 (overweight reachable categories). Punt = ×0.0
              (ignore abandoned cats).
            </div>
          </div>
        )}

        {/* Head-to-head */}
        {data && data.head_to_head.length > 0 && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200">
              Head-to-head — click an opponent
            </div>
            <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-slate-100 dark:border-slate-800">
              {data.head_to_head.map((h) => {
                const selected = h.opp_team_id === oppId
                return (
                  <button
                    key={h.opp_team_id}
                    onClick={() => setOppId(h.opp_team_id)}
                    className={
                      'rounded-md border px-3 py-1.5 text-xs ' +
                      (selected
                        ? 'bg-sky-100 border-sky-300 text-sky-900 dark:bg-sky-950/50 dark:border-sky-800 dark:text-sky-200'
                        : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800')
                    }
                  >
                    <span className="font-medium">{h.opp_team_name}</span>
                    <span className="ml-1 text-slate-500 dark:text-slate-400">
                      (#{formatRank(h.opp_standing)})
                    </span>
                    <span className="ml-2 tabular-nums">
                      <span className="text-emerald-700 dark:text-emerald-400">
                        W{h.cats_winning}
                      </span>
                      -
                      <span className="text-red-700 dark:text-red-400">
                        L{h.cats_losing}
                      </span>
                      {h.cats_tied > 0 && (
                        <>
                          -
                          <span className="text-slate-500 dark:text-slate-400">
                            T{h.cats_tied}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>

            {opp && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
                    <tr className="text-left">
                      <th className="px-3 py-2">Cat</th>
                      <th className="px-3 py-2 text-right">My now</th>
                      <th className="px-3 py-2 text-right">{opp.opp_team_name} now</th>
                      <th className="px-3 py-2 text-right">Current Δ</th>
                      <th className="px-3 py-2 text-right">My proj</th>
                      <th className="px-3 py-2 text-right">{opp.opp_team_name} proj</th>
                      <th className="px-3 py-2 text-right">Projected Δ</th>
                      <th className="px-3 py-2 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opp.cats.map((k) => (
                      <tr
                        key={k.cat}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="px-3 py-2 font-medium">{CAT_LABEL[k.cat]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{k.my_total}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{k.opp_total}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${signedTone(k.current_gap)}`}
                        >
                          {fmtSignedNum(k.current_gap)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {k.my_projected}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {k.opp_projected}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-medium ${signedTone(k.projected_gap)}`}
                        >
                          {fmtSignedNum(k.projected_gap)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={
                              'inline-block rounded px-2 py-0.5 text-xs font-medium ' +
                              (k.status === 'winning'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                                : k.status === 'losing'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
                                  : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')
                            }
                          >
                            {k.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {data && data.head_to_head.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No opponents — only one team configured.
          </p>
        )}
      </section>
    </main>
  )
}
