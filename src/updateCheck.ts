import { registerSW } from 'virtual:pwa-register'

/** Injected at build time — must match `/version.json` `buildId`. */
declare const __APP_BUILD_ID__: string

const POLL_MS = 2 * 60 * 1000

/**
 * Keep clients on the latest deploy:
 * 1) Service worker autoUpdate + periodic `registration.update()`
 * 2) Poll `/version.json` (never cached) and reload when buildId changes
 */
export function startUpdateChecks() {
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return
      const tick = () => {
        void registration.update()
      }
      window.setInterval(tick, POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tick()
      })
    },
  })

  let reloading = false
  const reloadToNewBuild = async () => {
    if (reloading) return
    reloading = true
    try {
      await updateSW(true)
    } catch {
      // No SW / already applying — fall through to hard reload.
    }
    window.location.reload()
  }

  const checkVersion = async () => {
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { buildId?: string }
      if (data.buildId && data.buildId !== __APP_BUILD_ID__) {
        await reloadToNewBuild()
      }
    } catch {
      // Offline or first paint before version.json exists — ignore.
    }
  }

  window.setInterval(() => void checkVersion(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkVersion()
  })
  // Avoid racing the first paint / SW install.
  window.setTimeout(() => void checkVersion(), 12_000)
}
