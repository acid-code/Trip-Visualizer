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
 * On Samsung standalone, 100dvh often under-reports so absolute bottom chrome floats
 * above a gap. Use innerHeight (not visualViewport) — Chrome tabs stay on CSS dvh.
 */
function syncStandaloneAppHeight() {
  if (!isStandaloneDisplay()) return
  try {
    const apply = () => {
      if (!isStandaloneDisplay()) return
      const h = Math.round(window.innerHeight)
      if (h > 0) {
        document.documentElement.style.setProperty('--app-vh', `${h}px`)
      }
    }
    apply()
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', () => {
      window.setTimeout(apply, 50)
      window.setTimeout(apply, 250)
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
