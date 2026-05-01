import { useEffect, useState } from 'react'
import { fetchDraftState, type DraftState } from './api'
import { Setup } from './views/Setup'
import { Draft } from './views/Draft'

type Mode = 'loading' | 'setup' | 'draft'

function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [error, setError] = useState<string | null>(null)
  const [initialState, setInitialState] = useState<DraftState | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const s = await fetchDraftState()
      setInitialState(s)
      setMode(s.teams.length === 0 ? 'setup' : 'draft')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMode('setup')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  if (mode === 'loading') {
    return (
      <main className="min-h-screen bg-slate-50 dark:bg-slate-950 grid place-items-center">
        {error ? (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300 max-w-md">
            {error}
          </div>
        ) : (
          <p className="text-slate-500 dark:text-slate-400">Loading…</p>
        )}
      </main>
    )
  }

  if (mode === 'setup') {
    const initial = initialState?.teams.map((t) => ({
      name: t.name,
      draft_slot: t.draft_slot,
      is_my_team: t.is_my_team,
    }))
    return <Setup initialTeams={initial} onSetupComplete={refresh} />
  }

  return <Draft onReset={refresh} />
}

export default App
