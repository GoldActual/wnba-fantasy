import { useEffect, useState } from 'react'
import { SIGN_IN_EVENT, useAdmin } from '../auth'
import { SignIn } from './SignIn'

/**
 * Header toolbar chip: "Sign in" when signed out, "Admin · Sign out"
 * when signed in. Owns the SignIn modal and listens for global
 * `admin-sign-in-required` events so any 401-catching view can pop the
 * modal via `promptSignIn(message)`.
 */
export function AuthChip() {
  const { signedIn, signOut } = useAdmin()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ error?: string }>
      setError(ce.detail?.error ?? null)
      setOpen(true)
    }
    window.addEventListener(SIGN_IN_EVENT, handler)
    return () => window.removeEventListener(SIGN_IN_EVENT, handler)
  }, [])

  return (
    <>
      {signedIn ? (
        <button
          type="button"
          onClick={signOut}
          title="Click to sign out"
          className="text-sm rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200 px-3 py-1.5 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
        >
          ✓ Admin · Sign out
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null)
            setOpen(true)
          }}
          className="text-sm rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          Sign in
        </button>
      )}
      <SignIn open={open} onClose={() => setOpen(false)} error={error} />
    </>
  )
}
