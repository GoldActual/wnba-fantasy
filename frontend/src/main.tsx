import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Spectator } from './views/Spectator'
import { applyTheme, getStoredTheme } from './theme'

// Apply persisted theme before React renders to avoid a flash of light.
applyTheme(getStoredTheme())

// `/spectator` is the polished public read-only dashboard shared via the
// Tailscale Funnel URL. Split here at the entry point — the spectator
// tree never imports owner state, fetches gated endpoints, or surfaces
// sign-in UI. Anything else falls through to the owner app.
const path = window.location.pathname
const isSpectator = path === '/spectator' || path === '/spectator/'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isSpectator ? <Spectator /> : <App />}
  </StrictMode>,
)
