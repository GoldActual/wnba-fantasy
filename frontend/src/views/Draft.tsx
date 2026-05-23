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
  type Slot,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'
import { AuthChip } from '../components/AuthChip'
import { AdminAuthError, promptSignIn, useAdmin } from '../auth'

type DraftProps = {
  onReset: () => void
  onSwitchToScoreboard?: () => void
  onSwitchToTransactions?: () => void
  onSwitchToPlayers?: () => void
  onSwitchToSimulator?: () => void
  onSwitchToStrategy?: () => void
  onSwitchToTrends?: () => void
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

function injuryBadge(p: Player) {
  const status = p.injury_status
  if (!status) return { dot: '🟢', tooltip: 'Healthy', tone: 'text-emerald-700 dark:text-emerald-400' }
  // Build a multi-line tooltip: status, description, ETA. <br>-style newlines
  // are flattened by the browser in title="" — \n is the right separator.
  const parts = [status]
  if (p.injury_description) parts.push(p.injury_description)
  if (p.injury_return_date) parts.push(`Est. return: ${p.injury_return_date}`)
  const tooltip = parts.join('\n')
  const s = status.toLowerCase()
  if (s.includes('out')) return { dot: '🔴', tooltip, tone: 'text-red-700 dark:text-red-300' }
  return { dot: '🟡', tooltip, tone: 'text-amber-700 dark:text-amber-300' }
}

type Standing = {
  team_id: number
  team_name: string
  is_my_team: boolean
  totals: Record<Cats, number>
  ranks: Record<Cats, number>
  rankSum: number
}

/** Rotis projected finish: per cat, rank teams by total (highest = #1).
 *  Lowest sum-of-ranks wins. Mirrors how 2024 league standings worked. */
function projectedStandings(state: DraftState): Standing[] {
  const out: Standing[] = state.teams.map((t) => {
    const status = state.team_cat_status[String(t.id)]
    const totals = (status?.totals ?? {
      points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
    }) as Record<Cats, number>
    return {
      team_id: t.id,
      team_name: t.name,
      is_my_team: !!t.is_my_team,
      totals,
      ranks: { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 },
      rankSum: 0,
    }
  })
  for (const cat of CATS) {
    const sorted = [...out].sort((a, b) => b.totals[cat] - a.totals[cat])
    sorted.forEach((s, i) => {
      const team = out.find((o) => o.team_id === s.team_id)!
      team.ranks[cat] = i + 1
    })
  }
  for (const s of out) s.rankSum = CATS.reduce((acc, c) => acc + s.ranks[c], 0)
  return out.sort((a, b) => a.rankSum - b.rankSum)
}

function Standings({ state, myTeamId }: { state: DraftState; myTeamId: number | null }) {
  const standings = useMemo(() => projectedStandings(state), [state])
  const winner = standings[0]
  const complete = state.is_complete
  const anyPicks = state.picks_made > 0

  // Mid-draft, slate styling (informational); post-draft, emerald (celebratory).
  const t = complete
    ? {
        ringBg: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40',
        title: 'text-emerald-900 dark:text-emerald-200',
        sub: 'text-emerald-800 dark:text-emerald-300',
        innerBorder: 'border-emerald-200/80 dark:border-emerald-900/60',
        thead: 'bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-300',
        rowBorder: 'border-emerald-100 dark:border-emerald-900/60',
      }
    : {
        ringBg: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900',
        title: 'text-slate-900 dark:text-slate-100',
        sub: 'text-slate-600 dark:text-slate-400',
        innerBorder: 'border-slate-200 dark:border-slate-800',
        thead: 'bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300',
        rowBorder: 'border-slate-100 dark:border-slate-800',
      }

  const headline = complete ? 'Draft complete · projected finish' : 'Live projected finish'
  const winnerLine = complete
    ? <>Winner if everyone hits their basis stats: <strong>{winner.team_name}</strong> (rank-sum {winner.rankSum})</>
    : anyPicks
      ? <>Currently leading: <strong>{winner.team_name}</strong> (rank-sum {winner.rankSum}) — partial picks; rankings settle as more picks are made</>
      : <>No picks yet — totals will populate live as the draft proceeds</>

  return (
    <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-4">
      <div className={`rounded-xl border px-5 py-4 ${t.ringBg}`}>
        <div className="flex flex-wrap items-baseline gap-2 mb-3">
          <h2 className={`text-lg font-semibold ${t.title}`}>{headline}</h2>
          <span className={`text-sm ${t.sub}`}>{winnerLine}</span>
        </div>
        <div className={`overflow-x-auto rounded border bg-white dark:bg-slate-900 ${t.innerBorder}`}>
          <table className="w-full text-sm">
            <thead className={t.thead}>
              <tr className="text-left">
                <th className="px-3 py-2 w-10 text-right">#</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2 w-16 text-right">Σ rank</th>
                {CATS.map((c) => (
                  <th key={c} className="px-3 py-2 w-20 text-right">{CAT_LABEL[c]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {standings.map((s, idx) => (
                <tr
                  key={s.team_id}
                  className={
                    `border-t ${t.rowBorder} ` +
                    (s.team_id === myTeamId ? 'bg-amber-50 dark:bg-amber-950/30 font-medium' : '')
                  }
                >
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{idx + 1}</td>
                  <td className="px-3 py-1.5">
                    {s.is_my_team && <span className="mr-1">★</span>}
                    {s.team_name}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{s.rankSum}</td>
                  {CATS.map((c) => (
                    <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                      <span className="text-slate-900 dark:text-slate-100">{s.totals[c]}</span>
                      <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">#{s.ranks[c]}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
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

export function Draft({
  onReset,
  onSwitchToScoreboard,
  onSwitchToTransactions,
  onSwitchToPlayers,
  onSwitchToSimulator,
  onSwitchToStrategy,
  onSwitchToTrends,
}: DraftProps) {
  const { signedIn } = useAdmin()
  const [state, setState] = useState<DraftState | null>(null)
  const [players, setPlayers] = useState<Player[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickPrompt, setPickPrompt] = useState<Player | null>(null)
  const [resetPrompt, setResetPrompt] = useState(false)
  const [busy, setBusy] = useState(false)

  // Filters / search
  const [search, setSearch] = useState('')
  const [positionFilter, setPositionFilter] = useState<'ALL' | 'G' | 'F' | 'C'>('ALL')
  const [rookieFilter, setRookieFilter] = useState<'all' | 'hide' | 'only'>('all')
  const [hideDrafted, setHideDrafted] = useState(true)
  const [fitMyNeeds, setFitMyNeeds] = useState(false)

  const refresh = async (forTeamId?: number) => {
    setError(null)
    try {
      const [s, p] = await Promise.all([
        fetchDraftState(),
        fetchPlayers(forTeamId !== undefined ? { for_team_id: forTeamId } : {}),
      ])
      setState(s)
      setPlayers(p.players)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    // First load: fetch state to learn which team is mine, then refetch
    // players with for_team_id so we get marginal values from pick #1.
    let cancelled = false
    void (async () => {
      try {
        const s = await fetchDraftState()
        if (cancelled) return
        setState(s)
        const myT = s.teams.find((t) => t.is_my_team)
        const p = await fetchPlayers(myT ? { for_team_id: myT.id } : {})
        if (cancelled) return
        setPlayers(p.players)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
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

  // Cat-strength comes from the server (`team_cat_status`) when teams exist.
  // Falls back to a local sum if state hasn't loaded yet.
  const myCatStatus = useMemo(() => {
    if (state && myTeam && state.team_cat_status[String(myTeam.id)]) {
      return state.team_cat_status[String(myTeam.id)]
    }
    return null
  }, [state, myTeam])

  const myCatTotals = useMemo(() => {
    if (myCatStatus) return myCatStatus.totals
    const totals: Record<Cats, number> = { points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0 }
    for (const r of myRosters) {
      const p = playerById.get(r.player_id)
      if (!p) continue
      for (const c of CATS) totals[c] += p.totals[c]
    }
    return totals
  }, [myCatStatus, myRosters, playerById])

  const paceColor = (ratio: number | null): string => {
    if (ratio == null) return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    if (ratio >= 0.95) return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900'
    if (ratio >= 0.75) return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
    return 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900'
  }

  const onClickPlayer = (p: Player) => {
    if (!state || !state.on_the_clock) return
    if (p.drafted_by_team_id != null) return // already gone
    if (!signedIn) {
      promptSignIn('Sign in as admin to draft players.')
      return
    }
    setPickPrompt(p)
  }

  const doPick = async (player_id: number, team_id?: number) => {
    setError(null)
    setBusy(true)
    try {
      const next = await makePick(player_id, team_id)
      setState(next)
      const myT = next.teams.find((t) => t.is_my_team)
      const p = await fetchPlayers(myT ? { for_team_id: myT.id } : {})
      setPlayers(p.players)
      setPickPrompt(null)
    } catch (e) {
      if (e instanceof AdminAuthError) {
        promptSignIn('Sign in as admin to make picks.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
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
      const myT = next.teams.find((t) => t.is_my_team)
      const p = await fetchPlayers(myT ? { for_team_id: myT.id } : {})
      setPlayers(p.players)
    } catch (e) {
      if (e instanceof AdminAuthError) {
        promptSignIn('Sign in as admin to undo picks.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const onResetDraft = async () => {
    setBusy(true)
    try {
      // The server requires force=true to wipe an in-progress draft. The
      // user has already confirmed via the modal, so pass it.
      await resetDraft(true)
      setResetPrompt(false)
      onReset()
    } catch (e) {
      if (e instanceof AdminAuthError) {
        promptSignIn('Sign in as admin to reset the draft.')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      setBusy(false)
    }
  }

  if (!state || !players) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 grid place-items-center">
        {error ? (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300 max-w-md">
            {error}
          </div>
        ) : (
          <p className="text-slate-500 dark:text-slate-400">Loading draft…</p>
        )}
      </main>
    )
  }

  const onClock = state.on_the_clock

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold">WNBA Fantasy Draft</h1>
          {onClock ? (
            <div className="flex items-baseline gap-2 text-sm">
              <span className="text-slate-500 dark:text-slate-400">On the clock:</span>
              <span className="font-semibold">{onClock.team_name}</span>
              <span className="text-slate-500 dark:text-slate-400">
                R{onClock.round}.P{onClock.overall_pick}
                {' · '}
                Pick {onClock.overall_pick} of {state.total_picks}
              </span>
            </div>
          ) : (
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Draft complete</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {signedIn && (
              <button
                onClick={onUndo}
                disabled={busy || state.picks_made === 0}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                Undo
              </button>
            )}
            <a
              href={draftCsvUrl}
              className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              CSV
            </a>
            {onSwitchToScoreboard && (
              <button
                onClick={onSwitchToScoreboard}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Scoreboard
              </button>
            )}
            {onSwitchToTransactions && (
              <button
                onClick={onSwitchToTransactions}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Transactions
              </button>
            )}
            {onSwitchToPlayers && (
              <button
                onClick={onSwitchToPlayers}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Players
              </button>
            )}
            {onSwitchToStrategy && (
              <button
                onClick={onSwitchToStrategy}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Strategy
              </button>
            )}
            {onSwitchToTrends && (
              <button
                onClick={onSwitchToTrends}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Trends
              </button>
            )}
            {onSwitchToSimulator && (
              <button
                onClick={onSwitchToSimulator}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Simulator
              </button>
            )}
            {signedIn && (
              <button
                onClick={() => setResetPrompt(true)}
                disabled={busy}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-red-50 hover:border-red-300 dark:hover:bg-red-950/40 dark:hover:border-red-900 disabled:opacity-50"
              >
                Reset
              </button>
            )}
            <SyncButton onSyncComplete={() => void refresh()} />
            <AuthChip />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 mt-4">
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        </div>
      )}

      {state.teams.length > 0 && (
        <Standings state={state} myTeamId={myTeam?.id ?? null} />
      )}

      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 grid grid-cols-12 gap-4">
        <section className="col-span-12 lg:col-span-8 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 shadow-sm overflow-hidden">
          <div className="p-3 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2">
            <input
              type="search"
              placeholder="Search player…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-md border border-slate-300 dark:border-slate-700 dark:bg-slate-800 px-3 py-1.5 text-sm w-56 focus:border-slate-500 dark:focus:border-slate-400 focus:outline-none"
            />
            <div className="inline-flex rounded-md border border-slate-300 dark:border-slate-700 text-sm overflow-hidden">
              {(['ALL', 'G', 'F', 'C'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPositionFilter(p)}
                  className={
                    'px-3 py-1.5 ' +
                    (positionFilter === p
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')
                  }
                >
                  {p === 'ALL' ? 'All' : p}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-md border border-slate-300 dark:border-slate-700 text-sm overflow-hidden">
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
                    (rookieFilter === k
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {myTeam && !myTeamFull && myNeeds.size > 0 && (
              <label
                className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
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
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={hideDrafted}
                onChange={(e) => setHideDrafted(e.target.checked)}
              />
              Hide drafted
            </label>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {filteredPlayers.length} / {players.length}
            </span>
          </div>
          <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
            <span><span className="text-emerald-600 dark:text-emerald-400">🟢</span> healthy</span>
            <span><span className="text-amber-600 dark:text-amber-400">🟡</span> day-to-day</span>
            <span><span className="text-red-600 dark:text-red-400">🔴</span> out</span>
            <span><span className="bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100 px-1 rounded text-[10px]">🆕</span> rookie (NCAA projection)</span>
            <span className="ml-auto">click a player to draft them</span>
          </div>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-2 w-10 text-right">#</th>
                  <th className="px-2 py-2">Player</th>
                  <th className="px-2 py-2 w-16">Pos</th>
                  <th className="hidden sm:table-cell px-2 py-2 w-14">Tm</th>
                  <th className="px-2 py-2 w-20 text-right">Value</th>
                  <th className="hidden sm:table-cell px-2 py-2 w-12 text-right">G</th>
                  <th className="hidden md:table-cell px-2 py-2 w-14 text-right">PTS</th>
                  <th className="hidden md:table-cell px-2 py-2 w-14 text-right">REB</th>
                  <th className="hidden md:table-cell px-2 py-2 w-14 text-right">AST</th>
                  <th className="hidden md:table-cell px-2 py-2 w-12 text-right">STL</th>
                  <th className="hidden md:table-cell px-2 py-2 w-12 text-right">BLK</th>
                </tr>
              </thead>
              <tbody>
                {filteredPlayers.map((p, idx) => {
                  const drafted = p.drafted_by_team_id != null
                  const inj = injuryBadge(p)
                  return (
                    <tr
                      key={p.player_id}
                      onClick={() => !drafted && onClickPlayer(p)}
                      className={
                        'border-t border-slate-100 dark:border-slate-800 ' +
                        (drafted
                          ? 'bg-slate-100 text-slate-400 dark:bg-slate-800/60 dark:text-slate-600 line-through cursor-not-allowed'
                          : 'hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer ') +
                        (!drafted && p.is_rookie ? 'bg-amber-50/40 dark:bg-amber-950/20' : '')
                      }
                    >
                      <td className="px-2 py-1.5 text-right text-slate-500 dark:text-slate-400 tabular-nums">{idx + 1}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span title={inj.tooltip} className={inj.tone}>{inj.dot}</span>
                          {p.is_rookie && (
                            <span
                              title={`🆕 Rookie — projected from ${p.school || 'NCAA'}; high uncertainty${
                                p.override_note ? ` · ${p.override_note}` : ''
                              }`}
                              className="rounded bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100 text-[10px] font-medium px-1 py-0.5"
                            >
                              🆕
                            </span>
                          )}
                          <span className="font-medium">{p.name}</span>
                          {p.is_rookie && p.draft_pick != null && (
                            <span className="text-xs text-slate-500 dark:text-slate-400">#{p.draft_pick}</span>
                          )}
                          {/* Tm column is hidden on phone, so surface it inline */}
                          <span className="sm:hidden ml-auto text-[11px] text-slate-500 dark:text-slate-400">
                            {p.wnba_team || ''}
                          </span>
                        </div>
                        {/* Cat columns are hidden on phone; show stats inline so the user
                            can see PTS/REB/AST/STL/BLK without horizontal-scrolling. */}
                        <div className="sm:hidden mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                          {p.totals.games_played}G
                          {' · '}{p.totals.points}P
                          {' · '}{p.totals.rebounds}R
                          {' · '}{p.totals.assists}A
                          {' · '}{p.totals.steals}S
                          {' · '}{p.totals.blocks}B
                        </div>
                        {/* Injury detail sub-line (mobile only) — desktop has the
                            hover tooltip on the dot, but tap doesn't trigger title=""
                            on phone. Show status + reason + ETA inline. */}
                        {p.injury_status && (
                          <div className={`sm:hidden mt-0.5 text-[11px] ${inj.tone}`}>
                            {p.injury_status}
                            {p.injury_description && <> · {p.injury_description}</>}
                            {p.injury_return_date && <> · ETA {p.injury_return_date}</>}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300">{p.positions.join('/') || '-'}</td>
                      <td className="hidden sm:table-cell px-2 py-1.5 text-slate-700 dark:text-slate-300">{p.wnba_team || '-'}</td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums font-medium"
                        title={
                          p.marginal_value != null
                            ? `Marginal value to ${myTeam?.name ?? 'my team'}: ${p.marginal_value.toFixed(2)}\nAbsolute (z-score sum × factors): ${p.value.toFixed(2)}`
                            : `Absolute value: ${p.value.toFixed(2)}`
                        }
                      >
                        {(p.marginal_value ?? p.value).toFixed(2)}
                      </td>
                      <td className="hidden sm:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.games_played}</td>
                      <td className="hidden md:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.points}</td>
                      <td className="hidden md:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.rebounds}</td>
                      <td className="hidden md:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.assists}</td>
                      <td className="hidden md:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.steals}</td>
                      <td className="hidden md:table-cell px-2 py-1.5 text-right tabular-nums">{p.totals.blocks}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="col-span-12 lg:col-span-4 space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">My team</h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
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
                      className="flex items-center justify-between rounded border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-sm"
                    >
                      <span className="text-slate-500 dark:text-slate-400 w-12 text-xs uppercase tracking-wide">{slot}</span>
                      <span className={r ? 'text-slate-900 dark:text-slate-100' : 'text-slate-300 dark:text-slate-600 italic'}>
                        {r ? r.player.name : '—'}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 w-16 text-right">
                        {r?.player.wnba_team || ''}
                      </span>
                    </li>
                  )
                })
              })}
            </ul>
            <div className="mt-3">
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                Pace ({myRosters.length}/6 picks){' '}
                <span className="text-slate-400 dark:text-slate-500">— vs avg team end-of-draft target</span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {CATS.map((c) => {
                  const info = myCatStatus?.by_cat?.[c]
                  const ratio = info?.ratio ?? null
                  const target = info?.target_end_of_draft
                  return (
                    <div
                      key={c}
                      className={'rounded border px-2 py-1.5 text-center ' + paceColor(ratio)}
                      title={
                        info
                          ? `Current ${info.current} / expected so far ${info.expected_so_far} / end-of-draft target ${info.target_end_of_draft}`
                          : 'No picks yet'
                      }
                    >
                      <div className="text-[10px] uppercase tracking-wide opacity-70">{CAT_LABEL[c]}</div>
                      <div className="text-sm font-semibold tabular-nums">{myCatTotals[c]}</div>
                      <div className="text-[10px] tabular-nums opacity-70">
                        {ratio != null ? `${(ratio * 100).toFixed(0)}%` : target ? `→${Math.round(target)}` : '—'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm">
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
                        'rounded border border-slate-200 dark:border-slate-800 ' +
                        (onClock?.team_id === t.id
                          ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-800'
                          : '')
                      }
                    >
                      <summary className="px-3 py-1.5 text-sm cursor-pointer flex items-center justify-between">
                        <span>
                          <span className="text-slate-500 dark:text-slate-400 mr-2">#{t.draft_slot}</span>
                          {t.name}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">{rs.length}/6</span>
                      </summary>
                      <ul className="px-3 pb-2 text-xs">
                        {rs.length === 0 && <li className="italic text-slate-400 dark:text-slate-500">no picks</li>}
                        {rs.map((r) => (
                          <li key={r.roster_id} className="flex justify-between py-0.5">
                            <span>
                              <span className="text-slate-400 dark:text-slate-500 mr-1">{r.slot}</span>
                              {r.player.name}
                            </span>
                            <span className="text-slate-400 dark:text-slate-500">P{r.drafted_overall_pick}</span>
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
          className="fixed inset-0 grid place-items-center bg-slate-900/40 dark:bg-black/60 z-50 p-3"
          onClick={() => setPickPrompt(null)}
        >
          <div
            className="bg-white dark:bg-slate-900 dark:border dark:border-slate-800 rounded-xl shadow-lg p-5 sm:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Draft <span className="text-slate-900 dark:text-slate-100">{pickPrompt.name}</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
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
                          ? 'bg-amber-400 text-slate-900 border-amber-500 hover:bg-amber-300 dark:bg-amber-500 dark:border-amber-600 dark:hover:bg-amber-400'
                          : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-700') +
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
              className="mt-4 text-xs text-slate-500 dark:text-slate-400 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {resetPrompt && (
        <div
          className="fixed inset-0 grid place-items-center bg-slate-900/40 dark:bg-black/60 z-50 p-3"
          onClick={() => !busy && setResetPrompt(false)}
        >
          <div
            className="bg-white dark:bg-slate-900 dark:border dark:border-slate-800 rounded-xl shadow-lg p-5 sm:p-6 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-red-700 dark:text-red-400">Reset draft?</h3>
            <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">
              This wipes <strong>{state.picks_made}</strong> pick{state.picks_made === 1 ? '' : 's'}
              {' '}and the team setup. The player database is unchanged. Cannot be undone.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setResetPrompt(false)}
                disabled={busy}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={onResetDraft}
                disabled={busy}
                className="rounded-md bg-red-600 text-white border border-red-700 px-3 py-2 text-sm font-medium hover:bg-red-500 disabled:opacity-50"
              >
                {busy ? 'Resetting…' : 'Wipe and reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
