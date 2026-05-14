import { useEffect, useRef, useState } from 'react'
import { fetchSyncStatus, triggerSync, type SyncStatus } from '../api'

const POLL_MS = 2000

function relativeTime(iso: string | null): string {
  if (!iso) return 'never synced'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'never synced'
  const delta = Date.now() - t
  if (delta < 60_000) return 'just now'
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Header button that triggers the in-app data sync (BBR gamelogs +
 * ESPN injuries) and surfaces progress. Calls `onSyncComplete` when a
 * running sync transitions to idle, so the host view can re-fetch its
 * data. */
export function SyncButton({ onSyncComplete }: { onSyncComplete?: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const wasRunningRef = useRef<boolean>(false)
  const tickRef = useRef<number>(0)
  const [, force] = useState(0)

  // Tick once a minute so the "Xm ago" label stays current without re-fetching.
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    let alive = true

    const poll = async () => {
      try {
        const s = await fetchSyncStatus()
        if (!alive) return
        setStatus(s)
        // Edge: was running, now idle → notify the host view.
        if (wasRunningRef.current && !s.running) {
          onSyncComplete?.()
        }
        wasRunningRef.current = s.running
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    // Initial fetch + interval. Faster polling while running, slower while idle.
    void poll()
    const id = window.setInterval(() => {
      void poll()
    }, POLL_MS)
    tickRef.current = id
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [onSyncComplete])

  const onClick = async () => {
    setError(null)
    try {
      const s = await triggerSync()
      setStatus(s)
      wasRunningRef.current = s.running
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const running = status?.running ?? false
  const label = running ? 'Syncing…' : 'Sync data'

  // Tooltip combines progress + last-completed timestamp so hover gives
  // the full picture without cluttering the button label.
  const tooltipBits: string[] = []
  if (running && status?.progress) tooltipBits.push(status.progress)
  if (status?.last_completed_at) {
    tooltipBits.push(`Last sync: ${new Date(status.last_completed_at).toLocaleString()}`)
  }
  if (status?.last_error && !running) tooltipBits.push(`Last error: ${status.last_error}`)
  const title = tooltipBits.join('\n')

  const subline = running
    ? status?.progress ?? 'Starting'
    : status?.last_error
      ? 'last sync failed'
      : relativeTime(status?.last_completed_at ?? null)

  return (
    <div className="flex flex-col items-end leading-tight" title={title}>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={running}
        className={`text-sm rounded-md border px-3 py-1.5 transition
          ${running
            ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 cursor-wait'
            : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
      >
        {running && <span className="mr-1 inline-block animate-pulse">●</span>}
        {label}
      </button>
      <span className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-[180px] truncate">
        {error ?? subline}
      </span>
    </div>
  )
}
