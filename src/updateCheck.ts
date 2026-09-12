import { registerSW } from 'virtual:pwa-register'
import { logClientInfo } from './data/clientLogs'

/** Injected at build time — must match `/version.json` `buildId`. */
declare const __APP_BUILD_ID__: string

const POLL_MS = 60 * 1000

/** Nuke service workers + Cache Storage, then reload (unsticks stubborn PWAs). */
export async function forceAppRefresh(): Promise<void> {
  logClientInfo('update', 'Force refresh — clearing service workers and caches')
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch {
    /* ignore */
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href)
  url.searchParams.set('_bust', String(Date.now()))
  window.location.replace(url.toString())
}

/**
 * Keep clients on the latest deploy:
 * 1) Service worker autoUpdate + periodic `registration.update()`
 * 2) Poll `/version.json` (never cached) and reload when buildId changes
 */
export function startUpdateChecks() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      void updateSW(true)
    },
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
    logClientInfo('update', 'New build detected — reloading')
    try {
      await updateSW(true)
    } catch {
      // No SW / already applying — hard bust instead.
    }
    try {
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch {
      /* ignore */
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

  // First check soon — don't wait 2 minutes when already stale.
  window.setTimeout(() => void checkVersion(), 2_000)
  window.setInterval(() => void checkVersion(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkVersion()
  })
}
