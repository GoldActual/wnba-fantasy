import { useEffect, useMemo, useState } from 'react'
import { fetchDraftState, fetchPlayers, type DraftState, type Player } from '../api'
import { ThemeToggle } from '../components/ThemeToggle'

type Cat = 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks'
const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

type Mode = 'fa' | 'roster'

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToSimulator: () => void
}

function injuryBadge(status: string | null): { dot: string; tone: string } {
  if (!status) return { dot: '', tone: '' }
  const s = status.toLowerCase()
  if (s.includes('out')) return { dot: '🔴', tone: 'text-red-700 dark:text-red-300' }
  return { dot: '🟡', tone: 'text-amber-700 dark:text-amber-300' }
}

export function Players({
  onSwitchToScoreboard,
  onSwitchToDraft,
  onSwitchToTransactions,
  onSwitchToSimulator,
}: Props) {
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [allPlayers, setAllPlayers] = useState<Player[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [mode, setMode] = useState<Mode>('fa')
  const [teamId, setTeamId] = useState<number | null>(null)  // for roster mode
  const [search, setSearch] = useState('')
  const [positionFilter, setPositionFilter] = useState<'ALL' | 'G' | 'F' | 'C'>('ALL')
  const [hideInjured, setHideInjured] = useState(false)

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
      // Default the team selector to my-team if not set yet.
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
  }, [])

  const filtered = useMemo(() => {
    if (!allPlayers) return []
    let list = allPlayers
    if (mode === 'fa') {
      list = list.filter((p) => p.drafted_by_team_id === null)
    } else if (mode === 'roster' && teamId !== null) {
      list = list.filter((p) => p.drafted_by_team_id === teamId)
    }
    const q = search.toLowerCase().trim()
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q))
    if (positionFilter !== 'ALL') {
      list = list.filter((p) => p.positions.includes(positionFilter))
    }
    if (hideInjured) {
      list = list.filter((p) => {
        const s = (p.injury_status ?? '').toLowerCase()
        return !s.includes('out')
      })
    }
    // FA mode: best at top. Roster mode: weakest at top (drop candidate).
    list = [...list].sort((a, b) =>
      mode === 'roster' ? a.value - b.value : b.value - a.value,
    )
    return list
  }, [allPlayers, mode, teamId, search, positionFilter, hideInjured])

  const dropCandidateId =
    mode === 'roster' && filtered.length > 0 ? filtered[0].player_id : null

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Players
          </h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Free agents and roster health · value uses 2026 actuals once a player has 10+ games, prior year before that
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onSwitchToScoreboard}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Scoreboard
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

        {/* Mode + filter row */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 flex flex-wrap items-center gap-3">
          <div className="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-700 text-sm">
            <button
              onClick={() => setMode('fa')}
              className={
                'px-3 py-1.5 ' +
                (mode === 'fa'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800')
              }
            >
              Free Agents
            </button>
            <button
              onClick={() => setMode('roster')}
              className={
                'px-3 py-1.5 ' +
                (mode === 'roster'
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800')
              }
            >
              Roster Health
            </button>
          </div>

          {mode === 'roster' && (
            <select
              value={teamId ?? ''}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : null)}
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
          )}

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name…"
            className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm grow min-w-[160px]"
          />

          <div className="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-700 text-sm">
            {(['ALL', 'G', 'F', 'C'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPositionFilter(p)}
                className={
                  'px-2 py-1.5 ' +
                  (positionFilter === p
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800')
                }
              >
                {p === 'ALL' ? 'All pos' : p}
              </button>
            ))}
          </div>

          <label className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1">
            <input
              type="checkbox"
              checked={hideInjured}
              onChange={(e) => setHideInjured(e.target.checked)}
            />
            Hide Out
          </label>

          <button
            onClick={() => void refresh()}
            disabled={busy}
            className="ml-auto text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? '…' : 'Refresh'}
          </button>
        </div>

        {mode === 'roster' && filtered.length > 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Sorted by value (lowest first) — top row is the current drop candidate.
          </p>
        )}
        {mode === 'fa' && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Sorted by value (best first) — top of the list is the strongest available pickup.
          </p>
        )}

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
                <tr className="text-left">
                  <th className="px-3 py-2 w-12 text-right">#</th>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2 w-16">Pos</th>
                  <th className="px-3 py-2 w-16">Team</th>
                  <th className="px-3 py-2 w-16 text-right">Value</th>
                  <th className="px-3 py-2 w-12 text-right">GP</th>
                  {CATS.map((c) => (
                    <th key={c} className="px-3 py-2 w-16 text-right">
                      {CAT_LABEL[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => {
                  const inj = injuryBadge(p.injury_status)
                  const flagged = p.player_id === dropCandidateId
                  return (
                    <tr
                      key={p.player_id}
                      className={
                        'border-t border-slate-100 dark:border-slate-800 ' +
                        (flagged ? 'bg-red-50 dark:bg-red-950/30 font-medium' : '')
                      }
                    >
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {i + 1}
                      </td>
                      <td className="px-3 py-1.5">
                        {inj.dot && (
                          <span className={`mr-1 ${inj.tone}`} title={p.injury_status ?? ''}>
                            {inj.dot}
                          </span>
                        )}
                        {p.is_rookie && (
                          <span className="mr-1" title="Rookie — projected stats">🆕</span>
                        )}
                        {p.name}
                        {flagged && (
                          <span className="ml-2 text-xs rounded bg-red-200 text-red-900 dark:bg-red-900/60 dark:text-red-200 px-1.5 py-0.5">
                            DROP CANDIDATE
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">{p.positions.join('/')}</td>
                      <td className="px-3 py-1.5">{p.wnba_team ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                        {p.value.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {p.totals.games_played}
                      </td>
                      {CATS.map((c) => (
                        <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                          {p.totals[c]}
                        </td>
                      ))}
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={6 + CATS.length}
                      className="px-3 py-6 text-center text-slate-500 dark:text-slate-400"
                    >
                      No players match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  )
}
