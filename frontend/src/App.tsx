import { useEffect, useMemo, useState } from 'react'
import { fetchPlayers, type Player } from './api'

type PositionFilter = 'ALL' | 'G' | 'F' | 'C'
type RookieFilter = 'all' | 'hide' | 'only'

function injuryBadge(status: string | null) {
  if (!status) return { dot: '🟢', label: 'Healthy', tone: 'text-emerald-700' }
  const s = status.toLowerCase()
  if (s.includes('out')) return { dot: '🔴', label: status, tone: 'text-red-700' }
  return { dot: '🟡', label: status, tone: 'text-amber-700' }
}

function App() {
  const [players, setPlayers] = useState<Player[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState<PositionFilter>('ALL')
  const [rookieFilter, setRookieFilter] = useState<RookieFilter>('all')

  useEffect(() => {
    fetchPlayers()
      .then((res) => setPlayers(res.players))
      .catch((e) => setError(e.message))
  }, [])

  const filtered = useMemo(() => {
    if (!players) return []
    const q = search.trim().toLowerCase()
    return players.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false
      if (position !== 'ALL' && !p.positions.includes(position)) return false
      if (rookieFilter === 'hide' && p.is_rookie) return false
      if (rookieFilter === 'only' && !p.is_rookie) return false
      return true
    })
  }, [players, search, position, rookieFilter])

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold">WNBA Fantasy Tracker</h1>
          <p className="text-slate-600 text-sm mt-1">
            Best Available — value = sum of 5 z-scores × availability × position × injury × rookie discount
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            Error loading players: {error}
          </div>
        )}

        <section className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            placeholder="Search player…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm w-64 focus:border-slate-500 focus:outline-none"
          />

          <div className="inline-flex rounded-md border border-slate-300 bg-white text-sm overflow-hidden">
            {(['ALL', 'G', 'F', 'C'] as PositionFilter[]).map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={
                  'px-3 py-2 ' +
                  (position === p
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100')
                }
              >
                {p === 'ALL' ? 'All pos.' : p}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-md border border-slate-300 bg-white text-sm overflow-hidden">
            {(
              [
                ['all', 'All players'],
                ['hide', 'Hide rookies'],
                ['only', 'Rookies only'],
              ] as [RookieFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setRookieFilter(key)}
                className={
                  'px-3 py-2 ' +
                  (rookieFilter === key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100')
                }
              >
                {label}
              </button>
            ))}
          </div>

          <span className="ml-auto text-sm text-slate-500">
            {players ? `${filtered.length} / ${players.length} players` : 'Loading…'}
          </span>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr className="text-left">
                <th className="px-3 py-2 w-12 text-right">#</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2 w-20">Pos</th>
                <th className="px-3 py-2 w-16">Team</th>
                <th className="px-3 py-2 w-24 text-right">Value</th>
                <th className="px-3 py-2 w-14 text-right">G</th>
                <th className="px-3 py-2 w-16 text-right">PTS</th>
                <th className="px-3 py-2 w-16 text-right">REB</th>
                <th className="px-3 py-2 w-16 text-right">AST</th>
                <th className="px-3 py-2 w-14 text-right">STL</th>
                <th className="px-3 py-2 w-14 text-right">BLK</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, idx) => {
                const inj = injuryBadge(p.injury_status)
                return (
                  <tr
                    key={p.player_id}
                    className={'border-t border-slate-100 hover:bg-slate-50 ' + (p.is_rookie ? 'bg-amber-50/40' : '')}
                  >
                    <td className="px-3 py-2 text-right text-slate-500 tabular-nums">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span title={inj.label} className={inj.tone}>
                          {inj.dot}
                        </span>
                        {p.is_rookie && (
                          <span
                            title={`🆕 Rookie — projected from ${p.school || 'NCAA'}; high uncertainty${
                              p.override_note ? ` · ${p.override_note}` : ''
                            }`}
                            className="rounded bg-amber-200 text-amber-900 text-xs font-medium px-1.5 py-0.5"
                          >
                            🆕
                          </span>
                        )}
                        <span className="font-medium">{p.name}</span>
                        {p.is_rookie && p.draft_pick != null && (
                          <span className="text-xs text-slate-500">#{p.draft_pick}</span>
                        )}
                      </div>
                      {p.is_rookie && p.school && (
                        <div className="text-xs text-slate-500">
                          {p.school}
                          {p.projected_mpg != null && ` · ${p.projected_mpg} MPG proj.`}
                          {p.stats_source === 'ncaa_projection' && ' · NCAA projection'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{p.positions.join('/') || '-'}</td>
                    <td className="px-3 py-2 text-slate-700">{p.wnba_team || '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {p.value.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {p.totals.games_played}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.totals.points}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.totals.rebounds}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.totals.assists}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.totals.steals}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.totals.blocks}</td>
                  </tr>
                )
              })}
              {!players && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-slate-500">
                    Loading player rankings…
                  </td>
                </tr>
              )}
              {players && filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-slate-500">
                    No players match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  )
}

export default App
