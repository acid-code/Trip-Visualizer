import { registerSW } from 'virtual:pwa-register'
import { logClientInfo } from './data/clientLogs'

/** Injected at build time — must match `/version.json` `buildId`. */
declare const __APP_BUILD_ID__: string

/** Quiet poll — frequent checks + SW apply caused full-app reload loops. */
const POLL_MS = 5 * 60 * 1000
const UPDATE_ATTEMPTED_KEY = 'trip-worker-update-attempted'

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
 * Keep clients on the latest deploy without reload loops:
 * - Poll `/version.json` every few minutes
 * - On mismatch, unregister SW + clear caches once per buildId (session)
 * - SW `registration.update()` only in the background — no auto page reload
 */
export function startUpdateChecks() {
  registerSW({
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

  const checkVersion = async () => {
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { buildId?: string }
      const remote = data.buildId
      if (!remote) return

      if (remote === __APP_BUILD_ID__) {
        try {
          sessionStorage.removeItem(UPDATE_ATTEMPTED_KEY)
        } catch {
          /* ignore */
        }
        return
      }

      // Already tried this remote id this tab — avoid restart loops with a sticky SW.
      try {
        if (sessionStorage.getItem(UPDATE_ATTEMPTED_KEY) === remote) return
        sessionStorage.setItem(UPDATE_ATTEMPTED_KEY, remote)
      } catch {
        /* private mode — still attempt once via reloading guard below */
      }

      logClientInfo('update', 'New build detected — clearing SW and reloading once')
      await forceAppRefresh()
    } catch {
      // Offline or first paint before version.json exists — ignore.
    }
  }

  window.setTimeout(() => void checkVersion(), 8_000)
  window.setInterval(() => void checkVersion(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkVersion()
  })
}
