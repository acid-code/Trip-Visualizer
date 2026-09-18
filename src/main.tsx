import { createRoot } from 'react-dom/client'
import App from './App'
import { startUpdateChecks } from './updateCheck'
import { applyColorMode, DEFAULT_COLOR_MODE } from './data/theme'
import './index.css'

applyColorMode(DEFAULT_COLOR_MODE)

function isStandaloneDisplay(): boolean {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true
    if ((navigator as Navigator & { standalone?: boolean }).standalone) return true
  } catch {
    /* ignore */
  }
  return false
}

/**
 * PWA-only: size the shell to window.innerHeight.
 * Debounced + threshold so Samsung gesture/chrome resize chatter does not
 * thrash layout (that made drive/walk paths look like they were redrawing).
 */
function syncStandaloneAppHeight() {
  if (!isStandaloneDisplay()) return
  try {
    let lastH = 0
    let timer = 0
    const apply = () => {
      if (!isStandaloneDisplay()) return
      const h = Math.round(window.innerHeight)
      if (h <= 0 || Math.abs(h - lastH) < 3) return
      lastH = h
      document.documentElement.style.setProperty('--app-vh', `${h}px`)
    }
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(apply, 120)
    }
    apply()
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', () => {
      window.setTimeout(apply, 50)
      window.setTimeout(apply, 300)
    })
  } catch {
    /* CSS 100dvh remains */
  }
}
syncStandaloneAppHeight()

// Never let update/SW bootstrap kill the app (phone black-screen after hard reset).
try {
  startUpdateChecks()
} catch (err) {
  console.error('[update] startUpdateChecks failed', err)
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
