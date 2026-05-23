/**
 * Admin token storage + subscription hook.
 *
 * The token is the single secret that turns this browser into an admin
 * client. Reads work tokenless (so the public Tailscale Funnel URL is
 * usable without sign-in); only write endpoints check it server-side.
 *
 * useSyncExternalStore so any view's header chip stays in sync with the
 * SignIn modal — if you sign in from one component, every other
 * mounted component re-renders.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'wnba_admin_token'

// Custom event bus — tiny, no deps. localStorage 'storage' event only
// fires across tabs, not within the same tab, so we need our own
// subscriber list for intra-tab updates.
const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setToken(t: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, t)
  } catch {
    // localStorage may be unavailable in private mode — fail silent;
    // a sign-in that doesn't persist is still better than crashing.
  }
  notify()
}

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  notify()
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

export type AdminState = {
  token: string | null
  signedIn: boolean
  signOut: () => void
}

export function useAdmin(): AdminState {
  const token = useSyncExternalStore(subscribe, getToken, getToken)
  return {
    token,
    signedIn: token !== null && token.length > 0,
    signOut: clearToken,
  }
}

/** Thrown by apiFetch when a write request comes back 401. */
export class AdminAuthError extends Error {
  constructor(message = 'admin token required') {
    super(message)
    this.name = 'AdminAuthError'
  }
}

/**
 * Fire from anywhere to open the SignIn modal (the AuthChip listens for
 * this event). Useful in catch blocks where you want to nudge the user
 * back into signing in after a 401, with context-specific copy.
 */
export function promptSignIn(error?: string): void {
  window.dispatchEvent(
    new CustomEvent('admin-sign-in-required', { detail: { error } }),
  )
}

export const SIGN_IN_EVENT = 'admin-sign-in-required'
