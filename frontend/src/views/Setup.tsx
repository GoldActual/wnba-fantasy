import { useState } from 'react'
import { setupTeams, type TeamSetupItem } from '../api'
import { ThemeToggle } from '../components/ThemeToggle'

type SetupProps = {
  initialTeams?: TeamSetupItem[]
  onSetupComplete: () => void
}

const DEFAULT_COUNT = 8
const MIN_TEAMS = 2
const MAX_TEAMS = 16

// Cole's actual league owners (2026: Sean is the new 8th). Pre-fills only
// when nothing already exists for that slot, so editing one name doesn't
// reset the others when count changes.
const DEFAULT_OWNER_NAMES = ['Cole', 'Tom', 'Eric', 'Nik', 'Bryan', 'Jay', 'Jordan', 'Sean']
const DEFAULT_MY_TEAM_NAME = 'Cole'

const buildDefaultTeams = (n: number, prev: TeamSetupItem[] = []): TeamSetupItem[] =>
  Array.from({ length: n }, (_, i) => {
    const slot = i + 1
    const existing = prev.find((t) => t.draft_slot === slot)
    if (existing) return existing
    const name = DEFAULT_OWNER_NAMES[i] || `Team ${slot}`
    return { name, draft_slot: slot, is_my_team: name === DEFAULT_MY_TEAM_NAME }
  })

export function Setup({ initialTeams = [], onSetupComplete }: SetupProps) {
  const [count, setCount] = useState<number>(initialTeams.length || DEFAULT_COUNT)
  const [teams, setTeams] = useState<TeamSetupItem[]>(
    initialTeams.length ? initialTeams : buildDefaultTeams(DEFAULT_COUNT),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateCount = (n: number) => {
    setCount(n)
    setTeams((prev) => buildDefaultTeams(n, prev))
  }

  const setName = (slot: number, name: string) =>
    setTeams((prev) => prev.map((t) => (t.draft_slot === slot ? { ...t, name } : t)))

  const setMyTeam = (slot: number) =>
    setTeams((prev) =>
      prev.map((t) => ({ ...t, is_my_team: t.draft_slot === slot })),
    )

  const submit = async () => {
    setError(null)
    if (teams.some((t) => !t.name.trim())) {
      setError('All team names must be non-empty.')
      return
    }
    if (!teams.some((t) => t.is_my_team)) {
      setError('Pick which team is yours so the My Team panel knows what to show.')
      return
    }
    setSubmitting(true)
    try {
      // The backend handles wipe+replace. If a draft is already in progress
      // we re-issue with force=true after explicit confirmation.
      try {
        await setupTeams(teams)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('409') && msg.includes('force=true')) {
          if (!window.confirm('A draft is already in progress. Wipe it and start over?')) {
            setSubmitting(false)
            return
          }
          await setupTeams(teams, true)
        } else {
          throw e
        }
      }
      onSetupComplete()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">Draft setup</h1>
            <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">
              Configure team count, names, and the snake order. Editable until the first pick is made.
            </p>
          </div>
          <ThemeToggle />
        </header>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <label className="text-sm text-slate-600 dark:text-slate-400">Team count</label>
            <input
              type="number"
              min={MIN_TEAMS}
              max={MAX_TEAMS}
              value={count}
              onChange={(e) => {
                const v = Math.max(MIN_TEAMS, Math.min(MAX_TEAMS, Number(e.target.value) || MIN_TEAMS))
                updateCount(v)
              }}
              className="w-20 rounded-md border border-slate-300 dark:border-slate-700 dark:bg-slate-800 px-2 py-1 text-sm"
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">{MIN_TEAMS}-{MAX_TEAMS} allowed</span>
          </div>

          <table className="w-full text-sm">
            <thead className="text-slate-500 dark:text-slate-400 text-left">
              <tr>
                <th className="px-2 py-1 w-16">Slot</th>
                <th className="px-2 py-1">Team name</th>
                <th className="px-2 py-1 w-24 text-center">My team</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.draft_slot} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-300">{t.draft_slot}</td>
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      value={t.name}
                      onChange={(e) => setName(t.draft_slot, e.target.value)}
                      className="w-full rounded border border-slate-300 dark:border-slate-700 dark:bg-slate-800 px-2 py-1 text-sm focus:border-slate-500 dark:focus:border-slate-400 focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input
                      type="radio"
                      name="my_team"
                      checked={!!t.is_my_team}
                      onChange={() => setMyTeam(t.draft_slot)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={submit}
              disabled={submitting}
              className="rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-4 py-2 text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Save and start drafting'}
            </button>
          </div>
        </section>
      </div>
    </main>
  )
}
