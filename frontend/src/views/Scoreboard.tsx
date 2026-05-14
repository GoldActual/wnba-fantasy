import { Fragment, useEffect, useState } from 'react'
import {
  fetchStandings,
  type Cat,
  type StandingsResponse,
  type StandingsTeam,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'
import { SyncButton } from '../components/SyncButton'

const CATS: Cat[] = ['points', 'rebounds', 'assists', 'steals', 'blocks']
const CAT_LABEL: Record<Cat, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
}

function formatRank(rank: number): string {
  // Show .5 only when it's a real tie; whole numbers stay terse.
  return Number.isInteger(rank) ? rank.toString() : rank.toFixed(1)
}

function injuryBadge(status: string | null): { dot: string; tone: string } {
  if (!status) return { dot: '', tone: '' }
  const s = status.toLowerCase()
  if (s.includes('out')) return { dot: '🔴', tone: 'text-red-700 dark:text-red-300' }
  return { dot: '🟡', tone: 'text-amber-700 dark:text-amber-300' }
}

function TeamPanel({
  team,
  showProjection,
}: {
  team: StandingsTeam
  showProjection: boolean
}) {
  const current = team.players.filter((p) => p.is_current_roster)
  const departed = team.players.filter((p) => !p.is_current_roster)
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 mt-2">
      <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 text-sm text-slate-600 dark:text-slate-400">
        Roster ({current.length}) — {team.games_played} games played
        {departed.length > 0 && (
          <span className="ml-2 text-xs">
            · {departed.length} traded-away contributor
            {departed.length > 1 ? 's' : ''} below
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300">
            <tr className="text-left">
              <th className="px-3 py-1.5">Player</th>
              <th className="px-3 py-1.5 w-12 text-right">GP</th>
              {CATS.map((c) => (
                <th key={c} className="px-3 py-1.5 w-16 text-right">
                  {CAT_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...current, ...departed].map((p) => {
              const inj = injuryBadge(p.injury_status)
              const departedStyle = !p.is_current_roster
                ? 'italic text-slate-500 dark:text-slate-400'
                : ''
              return (
                <tr
                  key={p.player_id}
                  className={`border-t border-slate-100 dark:border-slate-800 ${departedStyle}`}
                >
                  <td className="px-3 py-1.5">
                    {inj.dot && (
                      <span className={`mr-1 ${inj.tone}`} title={p.injury_status ?? ''}>
                        {inj.dot}
                      </span>
                    )}
                    {p.is_rookie && (
                      <span className="mr-1" title="Rookie — projected stats">
                        🆕
                      </span>
                    )}
                    {p.name}
                    <span className="ml-1 text-xs text-slate-400">
                      {p.wnba_team} · {p.positions.join('/')}
                      {!p.is_current_roster && ' · traded away'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{p.games}</td>
                  {CATS.map((c) => (
                    <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                      {p[c as keyof typeof p] as number}
                    </td>
                  ))}
                </tr>
              )
            })}
            {/* footer row: team total + projection */}
            <tr className="border-t-2 border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30 font-medium">
              <td className="px-3 py-1.5">Total</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {team.games_played}
              </td>
              {CATS.map((c) => (
                <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                  {team.cats[c].total}
                </td>
              ))}
            </tr>
            {showProjection && (
              <tr className="bg-slate-50/60 dark:bg-slate-800/30 text-slate-600 dark:text-slate-400">
                <td className="px-3 py-1.5 italic">Projected (full season)</td>
                <td className="px-3 py-1.5 text-right tabular-nums">—</td>
                {CATS.map((c) => (
                  <td key={c} className="px-3 py-1.5 text-right tabular-nums">
                    {team.cats[c].projected}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type ScoreboardProps = {
  onSwitchToDraft: () => void
  onSwitchToTransactions: () => void
  onSwitchToPlayers: () => void
  onSwitchToSimulator: () => void
}

export function Scoreboard({
  onSwitchToDraft,
  onSwitchToTransactions,
  onSwitchToPlayers,
  onSwitchToSimulator,
}: ScoreboardProps) {
  const [data, setData] = useState<StandingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [showProjection, setShowProjection] = useState(false)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      setData(await fetchStandings(2026))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Scoreboard
          </h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {data
              ? `Season ${data.season} · league at ${data.league_games_to_date} games of ${data.full_season_games}`
              : 'loading…'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1">
              <input
                type="checkbox"
                checked={showProjection}
                onChange={(e) => setShowProjection(e.target.checked)}
              />
              Show projection
            </label>
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
              onClick={onSwitchToPlayers}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Players
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
            <ThemeToggle />
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 mt-3">
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        </div>
      )}

      <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-4 pb-12">
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
                {data?.teams.map((t) => {
                  const isExpanded = expanded === t.team_id
                  return (
                    <Fragment key={t.team_id}>
                      <tr
                        onClick={() =>
                          setExpanded((cur) => (cur === t.team_id ? null : t.team_id))
                        }
                        className={
                          'border-t border-slate-100 dark:border-slate-800 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 ' +
                          (t.is_my_team ? 'bg-amber-50 dark:bg-amber-950/30 font-medium' : '')
                        }
                      >
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                          {formatRank(t.standing)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-slate-400 mr-1">
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          {t.is_my_team && <span className="mr-1">★</span>}
                          {t.team_name}
                        </td>
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
                                {showProjection ? cl.projected : cl.total}
                              </span>
                              <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                                #{formatRank(cl.rank)}
                              </span>
                            </td>
                          )
                        })}
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={4 + CATS.length} className="px-3 pb-3">
                            <TeamPanel team={t} showProjection={showProjection} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {data && data.teams.length === 0 && (
                  <tr>
                    <td
                      colSpan={4 + CATS.length}
                      className="px-3 py-6 text-center text-slate-500 dark:text-slate-400"
                    >
                      No teams configured.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {data && data.league_games_to_date === 0 && (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            Pre-season — every team starts at 0 in every category. Rankings populate as 2026 games are played and ingested.
          </p>
        )}
      </section>
    </main>
  )
}
