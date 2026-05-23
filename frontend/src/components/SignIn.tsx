import { useEffect, useRef, useState } from 'react'
import { setToken } from '../auth'

/**
 * Admin sign-in modal. Triggered from a header chip in every view's
 * toolbar. Single password field; validation deferred to the next write
 * attempt (any 401 from a write clears the token and re-prompts via
 * `error` prop).
 */
type Props = {
  open: boolean
  onClose: () => void
  error?: string | null
}

export function SignIn({ open, onClose, error }: Props) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setValue('')
      // Focus after the modal animates in (one tick).
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    setToken(trimmed)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-sm grid place-items-center px-4"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-5 space-y-3"
      >
        <h2 className="text-lg font-semibold">Sign in as admin</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Paste the admin token to enable drafting, transactions, and sync.
          Public reads work without signing in.
        </p>
        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="WNBA_ADMIN_TOKEN"
          className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          autoComplete="current-password"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="text-sm rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            Sign in
          </button>
        </div>
      </form>
    </div>
  )
}
