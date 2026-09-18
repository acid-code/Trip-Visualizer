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

/** Mark installed PWA so CSS can floor bottom safe-area (Android often reports 0). */
function markStandaloneShell() {
  try {
    const mq = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)')
    const apply = () => {
      const on = isStandaloneDisplay()
      document.documentElement.classList.toggle('is-pwa', on)
      document.documentElement.classList.toggle('is-standalone', on)
    }
    apply()
    mq.addEventListener?.('change', apply)
  } catch {
    /* ignore */
  }
}
markStandaloneShell()

/**
 * PWA-only: keep --app-vh tied to the visible viewport.
 * Skipped in Chrome tabs — URL-bar show/hide + visualViewport there causes jumpy gaps.
 */
function syncAppViewportHeight() {
  if (!isStandaloneDisplay()) return
  try {
    const apply = () => {
      if (!isStandaloneDisplay()) return
      const vv = window.visualViewport
      const h = Math.round(vv?.height ?? window.innerHeight)
      if (h > 0) {
        document.documentElement.style.setProperty('--app-vh', `${h}px`)
      }
    }
    apply()
    window.visualViewport?.addEventListener('resize', apply)
    window.visualViewport?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', () => {
      window.setTimeout(apply, 50)
      window.setTimeout(apply, 300)
    })
  } catch {
    /* ignore — CSS 100dvh fallback remains */
  }
}
syncAppViewportHeight()

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
