import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Spectator } from './views/Spectator'
import { applyTheme, getStoredTheme } from './theme'

// Apply persisted theme before React renders to avoid a flash of light.
applyTheme(getStoredTheme())

// The Tailscale Funnel URL is shared publicly. The bare URL (and any
// unknown path) lands on the polished read-only Spectator dashboard;
// the owner tool — Scoreboard with all the management tabs — lives at
// `/owner`. Split here at the entry point so the spectator tree never
// imports owner state, fetches gated endpoints, or surfaces sign-in UI.
// `/spectator` is preserved as an alias for any existing shared links.
const path = window.location.pathname
const isOwner = path === '/owner' || path === '/owner/'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOwner ? <App /> : <Spectator />}
  </StrictMode>,
)
