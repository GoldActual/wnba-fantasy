import { useEffect, useMemo, useState } from 'react'
import {
  fetchDraftState,
  fetchPlayers,
  fetchTransactions,
  postPickup,
  undoTransaction,
  type DraftState,
  type Player,
  type RosterEntry,
  type TeamSummary,
  type TransactionsResponse,
  type TxnCategory,
  type TxnEvent,
} from '../api'
import { ThemeToggle } from '../components/ThemeToggle'

// League rule (memory: project_league_no_team_trades): every transaction is
// 1-for-1, drop one rostered player + add one currently-unrostered player.
// The user calls these "trades" colloquially. Backend record_trade /
// /api/transactions/trade endpoints exist (team-to-team) but are not
// exposed in the UI — keeping them costs nothing and future-proofs against
// a rule change.

type Props = {
  onSwitchToScoreboard: () => void
  onSwitchToDraft: () => void
}

function todayIso(): string {
  // Local-date string for default <input type="date">. Avoids the
  // UTC-shifts-the-date trap of `new Date().toISOString()`.
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function UsageBar({
  label,
  used,
  total,
  tone,
}: {
  label: string
  used: number
  total: number
  tone: 'green' | 'amber' | 'red'
}) {
  const pct = total === 0 ? 0 : Math.min(100, (used / total) * 100)
  const colors = {
    green: 'bg-emerald-500 dark:bg-emerald-600',
    amber: 'bg-amber-500 dark:bg-amber-600',
    red: 'bg-red-500 dark:bg-red-600',
  }[tone]
  return (
    <div className="text-xs">
      <div className="flex justify-between text-slate-600 dark:text-slate-400 mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {total}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div className={`h-full ${colors}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function UsagePanel({ data }: { data: TransactionsResponse }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {data.usage.map((u) => {
        const stratTone =
          u.strategic_used >= data.limits.strategic_per_team
            ? 'red'
            : u.strategic_used >= data.limits.strategic_per_team - 1
            ? 'amber'
            : 'green'
        const injTone =
          u.injury_used >= data.limits.injury_per_team
            ? 'red'
            : u.injury_used >= data.limits.injury_per_team - 1
            ? 'amber'
            : 'green'
        return (
          <div
            key={u.team_id}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
          >
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              {u.team_name}
            </div>
            <div className="space-y-2">
              <UsageBar
                label="Strategic"
                used={u.strategic_used}
                total={data.limits.strategic_per_team}
                tone={stratTone}
              />
              <UsageBar
                label="Injury"
                used={u.injury_used}
                total={data.limits.injury_per_team}
                tone={injTone}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PickupForm({
  teams,
  rosters,
  freeAgents,
  busy,
  onSubmit,
  onCancel,
}: {
  teams: TeamSummary[]
  rosters: RosterEntry[]
  freeAgents: Player[]
  busy: boolean
  onSubmit: (body: {
    team_id: number
    drop_player_id: number
    add_player_id: number
    effective_date: string
    category: TxnCategory
    note: string
  }) => Promise<void>
  onCancel: () => void
}) {
  const [teamId, setTeamId] = useState<number>(teams[0]?.id ?? 0)
  const [dropId, setDropId] = useState<number | null>(null)
  const [addId, setAddId] = useState<number | null>(null)
  const [faQuery, setFaQuery] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [category, setCategory] = useState<TxnCategory>('strategic')
  const [note, setNote] = useState('')

  const teamRoster = rosters.filter((r) => r.team_id === teamId)
  const filteredFAs = useMemo(() => {
    const q = faQuery.toLowerCase().trim()
    const list = q ? freeAgents.filter((p) => p.name.toLowerCase().includes(q)) : freeAgents
    return list.slice(0, 100)
  }, [faQuery, freeAgents])

  const submitDisabled = busy || !teamId || dropId === null || addId === null

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (submitDisabled) return
        await onSubmit({
          team_id: teamId,
          drop_player_id: dropId!,
          add_player_id: addId!,
          effective_date: effectiveDate,
          category,
          note: note.trim(),
        })
      }}
      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
    >
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">
        Trade (drop one rostered, add one free agent)
      </h3>
      <div>
        <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
          Team
        </label>
        <select
          value={teamId}
          onChange={(e) => {
            setTeamId(Number(e.target.value))
            setDropId(null)
          }}
          className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
          Drop
        </label>
        <select
          value={dropId ?? ''}
          onChange={(e) => setDropId(e.target.value ? Number(e.target.value) : null)}
          className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
        >
          <option value="">— Pick a current rostered player —</option>
          {teamRoster.map((r) => (
            <option key={r.player_id} value={r.player_id}>
              {r.player.name} ({r.slot}, {r.player.positions.join('/') || '—'})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
          Add (free agent search)
        </label>
        <input
          type="text"
          value={faQuery}
          onChange={(e) => setFaQuery(e.target.value)}
          placeholder="Type to search…"
          className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm mb-1"
        />
        <select
          value={addId ?? ''}
          onChange={(e) => setAddId(e.target.value ? Number(e.target.value) : null)}
          size={6}
          className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
        >
          {filteredFAs.map((p) => (
            <option key={p.player_id} value={p.player_id}>
              {p.name} — {p.wnba_team ?? '—'} · {p.positions.join('/') || '—'}
              {' · '}value {p.value.toFixed(2)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
            Effective date
          </label>
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
            Category
          </label>
          <div className="flex gap-3 text-sm pt-1">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={category === 'strategic'}
                onChange={() => setCategory('strategic')}
              />
              Strategic
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={category === 'injury'}
                onChange={() => setCategory('injury')}
              />
              Injury
            </label>
          </div>
        </div>
      </div>
      <div>
        <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">
          Note (optional)
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitDisabled}
          className="rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Record trade'}
        </button>
      </div>
    </form>
  )
}

function EventRow({
  ev,
  onUndo,
  busy,
}: {
  ev: TxnEvent
  onUndo: (id: string) => void
  busy: boolean
}) {
  // Render as a one-line summary derived from the legs.
  let summary: string
  if (ev.event_type === 'pickup') {
    const drop = ev.legs.find((l) => l.transaction_type === 'drop')
    const add = ev.legs.find((l) => l.transaction_type === 'add')
    const team = drop?.from_team_name ?? add?.to_team_name ?? '?'
    summary = `${team}: drop ${drop?.player_name ?? '?'}, add ${add?.player_name ?? '?'}`
  } else if (ev.event_type === 'trade') {
    const a = ev.legs[0]
    const b = ev.legs[1]
    summary = `${a?.from_team_name ?? '?'} ↔ ${b?.from_team_name ?? '?'}: ${a?.player_name ?? '?'} for ${b?.player_name ?? '?'}`
  } else {
    summary = ev.legs.map((l) => `${l.transaction_type} ${l.player_name}`).join(', ')
  }
  const catBadge =
    ev.category === 'injury'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  return (
    <li className="flex items-center gap-3 px-3 py-2 border-t border-slate-100 dark:border-slate-800 first:border-t-0">
      <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400 w-24 shrink-0">
        {ev.effective_date}
      </span>
      <span className={`text-xs rounded px-1.5 py-0.5 ${catBadge}`}>
        {ev.category ?? '?'}
      </span>
      <span className="text-sm text-slate-900 dark:text-slate-100 grow">
        {summary}
        {ev.note && (
          <span className="ml-2 text-xs italic text-slate-500 dark:text-slate-400">
            "{ev.note}"
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onUndo(ev.event_id)}
        disabled={busy}
        className="text-xs rounded border border-slate-300 dark:border-slate-700 px-2 py-1 hover:bg-red-50 hover:border-red-300 dark:hover:bg-red-950/40 dark:hover:border-red-900 disabled:opacity-50"
      >
        Undo
      </button>
    </li>
  )
}

export function Transactions({ onSwitchToScoreboard, onSwitchToDraft }: Props) {
  const [data, setData] = useState<TransactionsResponse | null>(null)
  const [draftState, setDraftState] = useState<DraftState | null>(null)
  const [allPlayers, setAllPlayers] = useState<Player[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const [t, d, p] = await Promise.all([
        fetchTransactions(),
        fetchDraftState(),
        fetchPlayers({ limit: 1000 }),
      ])
      setData(t)
      setDraftState(d)
      setAllPlayers(p.players)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const freeAgents = useMemo(
    () => (allPlayers ?? []).filter((p) => p.drafted_by_team_id === null),
    [allPlayers],
  )

  const onPickup = async (body: {
    team_id: number
    drop_player_id: number
    add_player_id: number
    effective_date: string
    category: TxnCategory
    note: string
  }) => {
    setBusy(true)
    setError(null)
    try {
      await postPickup({
        team_id: body.team_id,
        add_player_id: body.add_player_id,
        drop_player_id: body.drop_player_id,
        effective_date: body.effective_date,
        category: body.category,
        note: body.note || undefined,
      })
      setFormOpen(false)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onUndo = async (eventId: string) => {
    if (!confirm('Undo this transaction? Rosters and standings will recompute.')) return
    setBusy(true)
    setError(null)
    try {
      await undoTransaction(eventId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Transactions
          </h1>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Drop one rostered, add one free agent · effective date settable backwards · 4 per team per season
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onSwitchToScoreboard}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Scoreboard
            </button>
            <button
              onClick={onSwitchToDraft}
              className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Draft board
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-3 sm:px-6 mt-4 pb-12 space-y-6">
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 dark:bg-red-950/40 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {data && <UsagePanel data={data} />}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            disabled={busy || formOpen}
            className="rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            + Trade
          </button>
        </div>

        {formOpen && draftState && (
          <PickupForm
            teams={draftState.teams}
            rosters={draftState.rosters}
            freeAgents={freeAgents}
            busy={busy}
            onSubmit={onPickup}
            onCancel={() => setFormOpen(false)}
          />
        )}

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200">
            Audit log {data && `(${data.events.length})`}
          </div>
          {data && data.events.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              No transactions yet — every team has 4 to spend (2 strategic + 2 injury).
            </div>
          )}
          <ul>
            {data?.events.map((ev) => (
              <EventRow key={ev.event_id} ev={ev} onUndo={onUndo} busy={busy} />
            ))}
          </ul>
        </div>
      </section>
    </main>
  )
}
