import { useEffect, useMemo, useState } from 'react'
import { fetchDraftState, fetchPlayers, type DraftState, type Player } from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'
import { AuthChip } from '../components/AuthChip'

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

// Sortable column identifiers. 'basis_<cat>' / 'season_<cat>' map to the
// two stat-column groups; 'gp_basis' / 'gp_season' are their GP columns.
type SortKey =
  | 'value'
  | 'weighted'
  | 'gp_basis'
  | 'gp_season'
  | `basis_${Cat}`
  | `season_${Cat}`
type SortDir = 'asc' | 'desc'

function sortValue(p: Player, key: SortKey): number {
  switch (key) {
    case 'value': return p.value
    case 'weighted': return p.strategy_weighted_value ?? p.value
    case 'gp_basis': return p.totals.games_played
    case 'gp_season': return p.season_totals.games_played
    default: {
      const [group, cat] = key.split('_') as ['basis' | 'season', Cat]
      return group === 'basis' ? p.totals[cat] : p.season_totals[cat]
    }
  }
}

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToSimulator: () => void
  onSwitchToStrategy: () => void
  onSwitchToTrends: () => void
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
  onSwitchToStrategy,
  onSwitchToTrends,
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
  // CP14 — when on, value column is weighted by `teamId`'s strategy
  // (Lock=×0.4, Contend=×1.5, Punt=×0.0). Off by default; the user opts in
  // once classifications are meaningful (low-sample mode early-season).
  const [applyStrategy, setApplyStrategy] = useState(false)
  const [strategyWeights, setStrategyWeights] = useState<Record<string, number> | null>(null)
  // Sort override. When null, falls back to the default (value/weighted —
  // desc in FA mode, asc in roster mode for drop-candidate ordering).
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const [d, p] = await Promise.all([
        fetchDraftState(),
        fetchPlayers({
          limit: 1000,
          ...(applyStrategy && teamId !== null ? { strategic_team_id: teamId } : {}),
        }),
      ])
      setDraftState(d)
      setAllPlayers(p.players)
      setStrategyWeights(p.strategy_weights)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyStrategy, teamId])

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
    // If the user has clicked a column header, honor that. Otherwise fall
    // back to the default: FA = best at top, roster = weakest at top (drop
    // candidate). Strategy mode swaps in weighted value as the default.
    if (sortKey !== null) {
      const dirMul = sortDir === 'asc' ? 1 : -1
      list = [...list].sort((a, b) => (sortValue(a, sortKey) - sortValue(b, sortKey)) * dirMul)
    } else {
      const score = (p: Player) =>
        applyStrategy && p.strategy_weighted_value !== null
          ? p.strategy_weighted_value
          : p.value
      list = [...list].sort((a, b) =>
        mode === 'roster' ? score(a) - score(b) : score(b) - score(a),
      )
    }
    return list
  }, [allPlayers, mode, teamId, search, positionFilter, hideInjured, applyStrategy, sortKey, sortDir])

  function onSortClick(key: SortKey): void {
    if (sortKey === key) {
      // Same column: toggle direction, or clear back to default after asc.
      if (sortDir === 'desc') setSortDir('asc')
      else setSortKey(null)
    } else {
      setSortKey(key)
      // GP/cat columns are most-useful descending; toggle from there.
      setSortDir('desc')
    }
  }

  function sortArrow(key: SortKey): string {
    if (sortKey !== key) return ''
    return sortDir === 'desc' ? ' ↓' : ' ↑'
  }

  // Drop candidate = lowest value player on the roster, regardless of how
  // the table is currently sorted. Pre-sort change, this was just
  // `filtered[0]`, which broke when the user sorted by PTS desc etc.
  const dropCandidateId = useMemo(() => {
    if (mode !== 'roster' || filtered.length === 0) return null
    const score = (p: Player) =>
      applyStrategy && p.strategy_weighted_value !== null
        ? p.strategy_weighted_value
        : p.value
    return [...filtered].sort((a, b) => score(a) - score(b))[0].player_id
  }, [filtered, mode, applyStrategy])

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Players
          </h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Free agents and roster health · Basis = stats driving value (2026 if 10+ GP, else 2025) · 2026 columns show season-to-date actuals
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onSwitchToScoreboard}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Scoreboard
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

          {(mode === 'roster' || applyStrategy) && (
            <select
              value={teamId ?? ''}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : null)}
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
              title={applyStrategy ? 'Strategy weights apply to this team' : 'Team to inspect'}
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

          <label
            className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1"
            title="Reweight FA value by the strategy classifier (Lock=×0.4, Contend=×1.5, Punt=×0.0) so the list emphasizes the cats this team actually needs to push."
          >
            <input
              type="checkbox"
              checked={applyStrategy}
              onChange={(e) => setApplyStrategy(e.target.checked)}
            />
            Apply strategy weights
          </label>

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

        {applyStrategy && strategyWeights && (
          <p className="text-xs text-slate-600 dark:text-slate-400 px-1">
            Strategy weights in effect:{' '}
            {CATS.map((c, i) => (
              <span key={c}>
                {i > 0 && ' · '}
                <span className="font-medium">{CAT_LABEL[c]}</span>
                ×{(strategyWeights[c] ?? 1).toFixed(1)}
              </span>
            ))}
            <span className="ml-2 italic">
              (Lock=×0.4, Contend=×1.5, Punt=×0.0 — set in the Strategy view)
            </span>
          </p>
        )}
        {sortKey === null && mode === 'roster' && filtered.length > 0 && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Sorted by {applyStrategy ? 'weighted ' : ''}value (lowest first) — top row is the current drop candidate. Click any column to re-sort.
          </p>
        )}
        {sortKey === null && mode === 'fa' && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Sorted by {applyStrategy ? 'weighted ' : ''}value (best first) — 🔥 flags players whose 2026 production projects above their basis. Click any column to re-sort.
          </p>
        )}
        {sortKey !== null && (
          <p className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-2">
            <span>
              Custom sort active ({sortKey} {sortDir}). Drop candidate (lowest value) still highlighted in red.
            </span>
            <button
              onClick={() => setSortKey(null)}
              className="text-xs rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              clear sort
            </button>
          </p>
        )}

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
                <tr className="text-left text-[11px] uppercase tracking-wide">
                  <th className="px-3 pt-2 pb-0 w-12" />
                  <th className="px-3 pt-2 pb-0" />
                  <th className="px-3 pt-2 pb-0 w-16" />
                  <th className="px-3 pt-2 pb-0 w-16" />
                  {applyStrategy && <th className="px-3 pt-2 pb-0 w-20" />}
                  <th className="px-3 pt-2 pb-0 w-16" />
                  <th
                    colSpan={CATS.length + 1}
                    className="px-3 pt-2 pb-0 text-right text-slate-500 dark:text-slate-400 border-l border-slate-200 dark:border-slate-800"
                    title="Stats driving the value column. 2026 actuals once a player has 10+ GP, else most recent prior wnba_actual season (usually 2025)."
                  >
                    Basis (drives value)
                  </th>
                  <th
                    colSpan={CATS.length + 1}
                    className="px-3 pt-2 pb-0 text-right text-emerald-700 dark:text-emerald-300 border-l border-slate-200 dark:border-slate-800"
                    title="2026 season-to-date totals from game_stats. 0 if the player hasn't appeared yet."
                  >
                    2026 season-to-date
                  </th>
                </tr>
                <tr className="text-left">
                  <th className="px-3 py-2 w-12 text-right">#</th>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2 w-16">Pos</th>
                  <th className="px-3 py-2 w-16">Team</th>
                  {applyStrategy && (
                    <th
                      onClick={() => onSortClick('weighted')}
                      className="px-3 py-2 w-20 text-right cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                      title="Strategy-weighted value: z-scores reweighted by Lock/Contend/Punt classifications before applying availability/position/injury/rookie factors. Click to sort."
                    >
                      Weighted{sortArrow('weighted')}
                    </th>
                  )}
                  <th
                    onClick={() => onSortClick('value')}
                    className="px-3 py-2 w-16 text-right cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                    title="Click to sort by value"
                  >
                    Value{sortArrow('value')}
                  </th>
                  <th
                    onClick={() => onSortClick('gp_basis')}
                    className="px-3 py-2 w-12 text-right border-l border-slate-200 dark:border-slate-800 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                    title="Basis GP. Click to sort."
                  >
                    GP{sortArrow('gp_basis')}
                  </th>
                  {CATS.map((c) => (
                    <th
                      key={`basis-${c}`}
                      onClick={() => onSortClick(`basis_${c}` as SortKey)}
                      className="px-3 py-2 w-16 text-right cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                      title={`Basis ${CAT_LABEL[c]}. Click to sort.`}
                    >
                      {CAT_LABEL[c]}{sortArrow(`basis_${c}` as SortKey)}
                    </th>
                  ))}
                  <th
                    onClick={() => onSortClick('gp_season')}
                    className="px-3 py-2 w-12 text-right border-l border-slate-200 dark:border-slate-800 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                    title="2026 GP. Click to sort."
                  >
                    GP{sortArrow('gp_season')}
                  </th>
                  {CATS.map((c) => (
                    <th
                      key={`season-${c}`}
                      onClick={() => onSortClick(`season_${c}` as SortKey)}
                      className="px-3 py-2 w-16 text-right cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800"
                      title={`2026 ${CAT_LABEL[c]}. Click to sort.`}
                    >
                      {CAT_LABEL[c]}{sortArrow(`season_${c}` as SortKey)}
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
                        {p.is_hot && (
                          <span
                            className="mr-1"
                            title="HOT — 2026 production projects materially above this player's value basis (role change or breakout). Look closer."
                          >
                            🔥
                          </span>
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
                      {applyStrategy && (
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                          {p.strategy_weighted_value !== null
                            ? p.strategy_weighted_value.toFixed(2)
                            : '—'}
                        </td>
                      )}
                      <td
                        className={
                          'px-3 py-1.5 text-right tabular-nums ' +
                          (applyStrategy
                            ? 'text-slate-500 dark:text-slate-400'
                            : 'font-semibold')
                        }
                      >
                        {p.value.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums border-l border-slate-100 dark:border-slate-800">
                        {p.totals.games_played}
                      </td>
                      {CATS.map((c) => (
                        <td key={`basis-${c}`} className="px-3 py-1.5 text-right tabular-nums">
                          {p.totals[c]}
                        </td>
                      ))}
                      <td
                        className={
                          'px-3 py-1.5 text-right tabular-nums border-l border-slate-100 dark:border-slate-800 ' +
                          (p.season_totals.games_played === 0
                            ? 'text-slate-400 dark:text-slate-600'
                            : '')
                        }
                      >
                        {p.season_totals.games_played}
                      </td>
                      {CATS.map((c) => (
                        <td
                          key={`season-${c}`}
                          className={
                            'px-3 py-1.5 text-right tabular-nums ' +
                            (p.season_totals.games_played === 0
                              ? 'text-slate-400 dark:text-slate-600'
                              : '')
                          }
                        >
                          {p.season_totals.games_played === 0 ? '—' : p.season_totals[c]}
                        </td>
                      ))}
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={(applyStrategy ? 8 : 7) + CATS.length * 2}
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
