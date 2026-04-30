import { useEffect, useMemo, useState } from 'react'
import {
  draftCsvUrl,
  fetchDraftState,
  fetchPlayers,
  makePick,
  resetDraft,
  undoLastPick,
  type DraftState,
  type Player,
  type RosterEntry,
  type Slot,
} from '../api'

type DraftProps = {
  onReset: () => void
}

type Cats = 'points' | 'rebounds' | 'assists' | 'steals' | 'blocks'
const CATS: Cats[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cats, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}
const ALL_SLOTS: Slot[] = ['G', 'F', 'C', 'UTIL']
const POSITIONAL_SLOTS: Array<Exclude<Slot, 'UTIL'>> = ['G', 'F', 'C']

function injuryBadge(status: string | null) {
  if (!status) return { dot: '🟢', label: 'Healthy', tone: 'text-emerald-700' }
  const s = status.toLowerCase()
  if (s.includes('out')) return { dot: '🔴', label: status, tone: 'text-red-700' }
  return { dot: '🟡', label: status, tone: 'text-amber-700' }
}

/** Positions still needed on a team's roster. UTIL is always implicit and
 *  not listed here — UTIL accepting anyone makes "fits remaining slots"
 *  trivially true if it's the only open slot, which isn't useful. */
function openPositionalNeeds(teamId: number, state: DraftState): Set<Exclude<Slot, 'UTIL'>> {
  const used: Record<string, number> = { G: 0, F: 0, C: 0 }
  for (const r of state.rosters) {
    if (r.team_id !== teamId) continue
    if (r.slot === 'G' || r.slot === 'F' || r.slot === 'C') used[r.slot] += 1
  }
  const needs = new Set<Exclude<Slot, 'UTIL'>>()
  for (const s of POSITIONAL_SLOTS) {
    if (used[s] < state.roster_shape[s]) needs.add(s)
  }
  return needs
}

export function Draft({ onReset }: DraftProps) {
  const [state, setState] = useState<DraftState | null>(null)
  const [players, setPlayers] = useState<Player[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickPrompt, setPickPrompt] = useState<Player | null>(null)
  const [busy, setBusy] = useState(false)

  // Filters / search
  const [search, setSearch] = useState('')
  const [positionFilter, setPositionFilter] = useState<'ALL' | 'G' | 'F' | 'C'>('ALL')
  const [rookieFilter, setRookieFilter] = useState<'all' | 'hide' | 'only'>('all')
  const [hideDrafted, setHideDrafted] = useState(true)
  const [fitMyNeeds, setFitMyNeeds] = useState(false)

  const refresh = async () => {
    setError(null)
    try {
      const [s, p] = await Promise.all([fetchDraftState(), fetchPlayers()])
      setState(s)
      setPlayers(p.players)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const playerById = useMemo(() => {
    const out = new Map<number, Player>()
    if (players) for (const p of players) out.set(p.player_id, p)
    return out
  }, [players])

  const myTeam = state?.teams.find((t) => t.is_my_team) ?? null

  const myNeeds = useMemo(
    () => (state && myTeam ? openPositionalNeeds(myTeam.id, state) : new Set<Exclude<Slot, 'UTIL'>>()),
    [state, myTeam],
  )

  const filteredPlayers = useMemo(() => {
    if (!players) return []
    const q = search.trim().toLowerCase()
    return players.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false
      if (positionFilter !== 'ALL' && !p.positions.includes(positionFilter)) return false
      if (rookieFilter === 'hide' && p.is_rookie) return false
      if (rookieFilter === 'only' && !p.is_rookie) return false
      if (hideDrafted && p.drafted_by_team_id != null) return false
      if (fitMyNeeds && myNeeds.size > 0) {
        const matches = p.positions.some((pp) =>
          (pp === 'G' || pp === 'F' || pp === 'C') && myNeeds.has(pp),
        )
        if (!matches) return false
      }
      return true
    })
  }, [players, search, positionFilter, rookieFilter, hideDrafted, fitMyNeeds, myNeeds])
  const myRosters = useMemo(
    () => (state && myTeam ? state.rosters.filter((r) => r.team_id === myTeam.id) : []),
    [state, myTeam],
  )

  const myTeamFull = !!state && !!myTeam && myRosters.length >= state.total_picks / state.teams.length

  const myCatTotals = useMemo(() => {
    const totals: Record<Cats, number> = { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 }
    for (const r of myRosters) {
      const p = playerById.get(r.player_id)
      if (!p) continue
      for (const c of CATS) totals[c] += p.totals[c]
    }
    return totals
  }, [myRosters, playerById])

  const onClickPlayer = (p: Player) => {
    if (!state || !state.on_the_clock) return
    if (p.drafted_by_team_id != null) return // already gone
    setPickPrompt(p)
  }

  const doPick = async (player_id: number, team_id?: number) => {
    setError(null)
    setBusy(true)
    try {
      const next = await makePick(player_id, team_id)
      setState(next)
      const p = await fetchPlayers()
      setPlayers(p.players)
      setPickPrompt(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onUndo = async () => {
    setError(null)
    setBusy(true)
    try {
      const next = await undoLastPick()
      setState(next)
      const p = await fetchPlayers()
      setPlayers(p.players)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onResetDraft = async () => {
    if (
      !window.confirm(
        'Reset the draft? This wipes all picks and team setup. The player database is unchanged.',
      )
    )
      return
    setBusy(true)
    try {
      await resetDraft()
      onReset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!state || !players) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900 grid place-items-center">
        {error ? (
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 max-w-md">
            {error}
          </div>
        ) : (
          <p className="text-slate-500">Loading draft…</p>
        )}
      </main>
    )
  }

  const onClock = state.on_the_clock

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-3 flex flex-wrap items-center gap-4">
          <h1 className="text-xl font-semibold">WNBA Fantasy Draft</h1>
          {onClock ? (
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-slate-500">On the clock:</span>
              <span className="font-semibold">{onClock.team_name}</span>
              <span className="text-slate-500">
                R{onClock.round}.P{onClock.overall_pick}
                {' · '}
                Pick {onClock.overall_pick} of {state.total_picks}
              </span>
            </div>
          ) : (
            <span className="text-sm font-medium text-emerald-700">Draft complete</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onUndo}
              disabled={busy || state.picks_made === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
            >
              Undo
            </button>
            <a
              href={draftCsvUrl}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              CSV
            </a>
            <button
              onClick={onResetDraft}
              disabled={busy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-red-50 hover:border-red-300 disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-6 mt-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-6 py-4 grid grid-cols-12 gap-4">
        <section className="col-span-12 lg:col-span-8 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
            <input
              type="search"
              placeholder="Search player…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-56 focus:border-slate-500 focus:outline-none"
            />
            <div className="inline-flex rounded-md border border-slate-300 text-sm overflow-hidden">
              {(['ALL', 'G', 'F', 'C'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPositionFilter(p)}
                  className={
                    'px-3 py-1.5 ' +
                    (positionFilter === p ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100')
                  }
                >
                  {p === 'ALL' ? 'All' : p}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md border border-slate-300 text-sm overflow-hidden">
              {(
                [
                  ['all', 'All'],
                  ['hide', 'Hide rookies'],
                  ['only', 'Rookies only'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setRookieFilter(k)}
                  className={
                    'px-3 py-1.5 ' +
                    (rookieFilter === k ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {myTeam && !myTeamFull && myNeeds.size > 0 && (
              <label
                className="inline-flex items-center gap-2 text-sm text-slate-700"
                title={`Show only players whose positions match an open slot on ${myTeam.name}: ${[...myNeeds].join('/')}`}
              >
                <input
                  type="checkbox"
                  checked={fitMyNeeds}
                  onChange={(e) => setFitMyNeeds(e.target.checked)}
                />
                Fits my needs ({[...myNeeds].join('/')})
              </label>
            )}
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={hideDrafted}
                onChange={(e) => setHideDrafted(e.target.checked)}
              />
              Hide drafted
            </label>
            <span className="text-xs text-slate-500">
              {filteredPlayers.length} / {players.length}
            </span>
          </div>
          <div className="px-3 py-1.5 border-b border-slate-100 text-[11px] text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <span><span className="text-emerald-600">🟢</span> healthy</span>
            <span><span className="text-amber-600">🟡</span> day-to-day</span>
            <span><span className="text-red-600">🔴</span> out</span>
            <span><span className="bg-amber-200 text-amber-900 px-1 rounded text-[10px]">🆕</span> rookie (NCAA projection)</span>
            <span className="ml-auto">click a player to draft them</span>
          </div>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-2 w-10 text-right">#</th>
                  <th className="px-2 py-2">Player</th>
                  <th className="px-2 py-2 w-16">Pos</th>
                  <th className="px-2 py-2 w-14">Tm</th>
                  <th className="px-2 py-2 w-20 text-right">Value</th>
                  <th className="px-2 py-2 w-12 text-right">G</th>
                  <th className="px-2 py-2 w-14 text-right">PTS</th>
                  <th className="px-2 py-2 w-14 text-right">REB</th>
                  <th className="px-2 py-2 w-14 text-right">AST</th>
                  <th className="px-2 py-2 w-12 text-right">STL</th>
                  <th className="px-2 py-2 w-12 text-right">BLK</th>
                </tr>
              </thead>
              <tbody>
                {filteredPlayers.map((p, idx) => {
                  const drafted = p.drafted_by_team_id != null
                  const inj = injuryBadge(p.injury_status)
                  return (
                    <tr
                      key={p.player_id}
                      onClick={() => !drafted && onClickPlayer(p)}
                      className={
                        'border-t border-slate-100 ' +
                        (drafted
                          ? 'bg-slate-100 text-slate-400 line-through cursor-not-allowed'
                          : 'hover:bg-amber-50 cursor-pointer ') +
                        (!drafted && p.is_rookie ? 'bg-amber-50/40' : '')
                      }
                    >
                      <td className="px-2 py-1.5 text-right text-slate-500 tabular-nums">{idx + 1}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span title={inj.label} className={inj.tone}>{inj.dot}</span>
                          {p.is_rookie && (
                            <span
                              title={`🆕 Rookie — projected from ${p.school || 'NCAA'}; high uncertainty${
                                p.override_note ? ` · ${p.override_note}` : ''
                              }`}
                              className="rounded bg-amber-200 text-amber-900 text-[10px] font-medium px-1 py-0.5"
                            >
                              🆕
                            </span>
                          )}
                          <span className="font-medium">{p.name}</span>
                          {p.is_rookie && p.draft_pick != null && (
                            <span className="text-xs text-slate-500">#{p.draft_pick}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-slate-700">{p.positions.join('/') || '-'}</td>
                      <td className="px-2 py-1.5 text-slate-700">{p.wnba_team || '-'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{p.value.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.games_played}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.points}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.rebounds}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.assists}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.steals}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.totals.blocks}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="col-span-12 lg:col-span-4 space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">My team</h2>
              <span className="text-xs text-slate-500">
                {myTeam ? `${myTeam.name} · slot ${myTeam.draft_slot}` : 'Pick a team in setup'}
              </span>
            </div>
            <ul className="space-y-1">
              {ALL_SLOTS.flatMap((slot) => {
                const cap = state.roster_shape[slot]
                const filled = myRosters.filter((r) => r.slot === slot)
                return Array.from({ length: cap }, (_, i) => {
                  const r = filled[i]
                  return (
                    <li
                      key={`${slot}-${i}`}
                      className="flex items-center justify-between rounded border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <span className="text-slate-500 w-12 text-xs uppercase tracking-wide">{slot}</span>
                      <span className={r ? 'text-slate-900' : 'text-slate-300 italic'}>
                        {r ? r.player.name : '—'}
                      </span>
                      <span className="text-xs text-slate-500 w-16 text-right">
                        {r?.player.wnba_team || ''}
                      </span>
                    </li>
                  )
                })
              })}
            </ul>
            <div className="mt-3 grid grid-cols-5 gap-2 text-center">
              {CATS.map((c) => (
                <div key={c} className="rounded bg-slate-50 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{CAT_LABEL[c]}</div>
                  <div className="text-sm font-semibold tabular-nums">{myCatTotals[c]}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold mb-2">Other teams</h2>
            <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
              {state.teams
                .filter((t) => !t.is_my_team)
                .sort((a, b) => a.draft_slot - b.draft_slot)
                .map((t) => {
                  const rs = state.rosters.filter((r) => r.team_id === t.id)
                  return (
                    <details
                      key={t.id}
                      className={
                        'rounded border border-slate-200 ' +
                        (onClock?.team_id === t.id ? 'bg-amber-50 border-amber-300' : '')
                      }
                    >
                      <summary className="px-3 py-1.5 text-sm cursor-pointer flex items-center justify-between">
                        <span>
                          <span className="text-slate-500 mr-2">#{t.draft_slot}</span>
                          {t.name}
                        </span>
                        <span className="text-xs text-slate-500">{rs.length}/6</span>
                      </summary>
                      <ul className="px-3 pb-2 text-xs">
                        {rs.length === 0 && <li className="italic text-slate-400">no picks</li>}
                        {rs.map((r) => (
                          <li key={r.roster_id} className="flex justify-between py-0.5">
                            <span>
                              <span className="text-slate-400 mr-1">{r.slot}</span>
                              {r.player.name}
                            </span>
                            <span className="text-slate-400">P{r.drafted_overall_pick}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )
                })}
            </div>
          </section>
        </aside>
      </div>

      {pickPrompt && state && (
        <div
          className="fixed inset-0 grid place-items-center bg-slate-900/40 z-50"
          onClick={() => setPickPrompt(null)}
        >
          <div
            className="bg-white rounded-xl shadow-lg p-6 w-[28rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Draft <span className="text-slate-900">{pickPrompt.name}</span>
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {pickPrompt.positions.join('/') || 'no position'}
              {pickPrompt.wnba_team ? ` · ${pickPrompt.wnba_team}` : ''} · click any team
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[...state.teams]
                .sort((a, b) => a.draft_slot - b.draft_slot)
                .map((t) => {
                  const isClock = onClock?.team_id === t.id
                  const teamRosterCount = state.rosters.filter((r) => r.team_id === t.id).length
                  const teamFull = teamRosterCount >= state.total_picks / state.teams.length
                  return (
                    <button
                      key={t.id}
                      disabled={busy || teamFull}
                      onClick={() => doPick(pickPrompt.player_id, t.id)}
                      className={
                        'rounded-md px-3 py-2 text-sm font-medium border ' +
                        (isClock
                          ? 'bg-amber-400 text-slate-900 border-amber-500 hover:bg-amber-300'
                          : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50') +
                        ' disabled:opacity-40 disabled:cursor-not-allowed'
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {t.is_my_team && '★ '}
                          {t.name}
                        </span>
                        <span className="text-xs opacity-70 tabular-nums">{teamRosterCount}/6</span>
                      </div>
                      {isClock && (
                        <div className="text-[10px] uppercase tracking-wide opacity-70">on the clock</div>
                      )}
                    </button>
                  )
                })}
            </div>
            <button
              onClick={() => setPickPrompt(null)}
              className="mt-4 text-xs text-slate-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
