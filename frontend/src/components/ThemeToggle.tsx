import { useEffect, useState } from 'react'
import { getStoredTheme, setTheme, type Theme } from '../theme'

export function ThemeToggle() {
  const [theme, setT] = useState<Theme>(() => getStoredTheme())

  useEffect(() => {
    setTheme(theme)
  }, [theme])

  const toggle = () => setT((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
    >
      {theme === 'dark' ? '☀︎' : '☾'}
    </button>
  )
}
