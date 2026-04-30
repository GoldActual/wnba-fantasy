import { useEffect, useState } from 'react'
import { apiFetch, type Health } from './api'

function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Health>('/api/health')
      .then(setHealth)
      .catch((e) => setError(e.message))
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-semibold mb-2">WNBA Fantasy Tracker</h1>
        <p className="text-slate-600 mb-8">Checkpoint 1 — scaffold smoke test</p>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-medium mb-4">API health</h2>
          {error && <p className="text-red-600">Error: {error}</p>}
          {!error && !health && <p className="text-slate-500">Loading…</p>}
          {health && (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">status</dt>
              <dd className="font-mono">{health.status}</dd>
              <dt className="text-slate-500">db_connected</dt>
              <dd className="font-mono">{String(health.db_connected)}</dd>
              <dt className="text-slate-500">player_count</dt>
              <dd className="font-mono">{health.player_count}</dd>
            </dl>
          )}
        </section>
      </div>
    </main>
  )
}

export default App
