import { useEffect, useState } from 'react'
import { fetchDraftState, type DraftState } from './api'
import { Setup } from './views/Setup'
import { Draft } from './views/Draft'
import { Scoreboard } from './views/Scoreboard'
import { Transactions } from './views/Transactions'
import { Players } from './views/Players'
import { Simulator } from './views/Simulator'
import { Strategy } from './views/Strategy'

type Mode =
  | 'loading'
  | 'setup'
  | 'draft'
  | 'scoreboard'
  | 'transactions'
  | 'players'
  | 'simulator'
  | 'strategy'

function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [error, setError] = useState<string | null>(null)
  const [initialState, setInitialState] = useState<DraftState | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const s = await fetchDraftState()
      setInitialState(s)
      if (s.teams.length === 0) {
        setMode('setup')
      } else if (s.is_complete) {
        // Once the draft is over, the scoreboard is the home view.
        // Other in-season views stay accessible via header toggles.
        setMode((cur) =>
          cur === 'draft' ||
          cur === 'transactions' ||
          cur === 'players' ||
          cur === 'simulator' ||
          cur === 'strategy'
            ? cur
            : 'scoreboard',
        )
      } else {
        setMode('draft')
      }
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

  if (mode === 'scoreboard') {
    return (
      <Scoreboard
        onSwitchToDraft={() => setMode('draft')}
        onSwitchToTransactions={() => setMode('transactions')}
        onSwitchToPlayers={() => setMode('players')}
        onSwitchToSimulator={() => setMode('simulator')}
        onSwitchToStrategy={() => setMode('strategy')}
      />
    )
  }

  if (mode === 'transactions') {
    return (
      <Transactions
        onSwitchToScoreboard={() => setMode('scoreboard')}
        onSwitchToDraft={() => setMode('draft')}
        onSwitchToPlayers={() => setMode('players')}
        onSwitchToSimulator={() => setMode('simulator')}
        onSwitchToStrategy={() => setMode('strategy')}
      />
    )
  }

  if (mode === 'players') {
    return (
      <Players
        onSwitchToScoreboard={() => setMode('scoreboard')}
        onSwitchToDraft={() => setMode('draft')}
        onSwitchToTransactions={() => setMode('transactions')}
        onSwitchToSimulator={() => setMode('simulator')}
        onSwitchToStrategy={() => setMode('strategy')}
      />
    )
  }

  if (mode === 'simulator') {
    return (
      <Simulator
        onSwitchToScoreboard={() => setMode('scoreboard')}
        onSwitchToDraft={() => setMode('draft')}
        onSwitchToTransactions={() => setMode('transactions')}
        onSwitchToPlayers={() => setMode('players')}
        onSwitchToStrategy={() => setMode('strategy')}
      />
    )
  }

  if (mode === 'strategy') {
    return (
      <Strategy
        onSwitchToScoreboard={() => setMode('scoreboard')}
        onSwitchToDraft={() => setMode('draft')}
        onSwitchToTransactions={() => setMode('transactions')}
        onSwitchToPlayers={() => setMode('players')}
        onSwitchToSimulator={() => setMode('simulator')}
      />
    )
  }

  return (
    <Draft
      onReset={refresh}
      onSwitchToScoreboard={() => setMode('scoreboard')}
      onSwitchToTransactions={() => setMode('transactions')}
      onSwitchToPlayers={() => setMode('players')}
      onSwitchToSimulator={() => setMode('simulator')}
      onSwitchToStrategy={() => setMode('strategy')}
    />
  )
}

export default App
