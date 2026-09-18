import { registerSW } from 'virtual:pwa-register'
import { logClientInfo } from './data/clientLogs'

/** Injected at build time — must match `/version.json` `buildId`. */
declare const __APP_BUILD_ID__: string

/** Quiet poll — frequent checks + SW apply caused full-app reload loops. */
const POLL_MS = 5 * 60 * 1000
const ATTEMPTS_KEY = 'trip-worker-update-attempts'
const MAX_FORCE_ATTEMPTS = 2

export type ServerVersion = {
  buildId: string
  builtAt?: string
  deploymentId?: string
  vercelEnv?: string
}

type AttemptState = {
  buildId: string
  count: number
  at: number
}

/** True for `vite` / localhost — never auto-reload a local session. */
export function isLocalAppEnv(): boolean {
  if (import.meta.env.DEV) return true
  try {
    const host = window.location.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

export function getClientBuildId(): string {
  return typeof __APP_BUILD_ID__ === 'string' && __APP_BUILD_ID__
    ? __APP_BUILD_ID__
    : 'unknown'
}

/** Short label for UI (full git SHA → 7 chars). */
export function formatBuildLabel(buildId: string): string {
  const id = buildId.trim()
  if (!id) return '—'
  if (id.startsWith('local-')) return id.slice(0, 18)
  if (/^[a-f0-9]{40}$/i.test(id)) return id.slice(0, 7)
  return id.length > 16 ? `${id.slice(0, 12)}…` : id
}

function readAttempts(): AttemptState | null {
  try {
    const raw = sessionStorage.getItem(ATTEMPTS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AttemptState
    if (!parsed?.buildId || typeof parsed.count !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writeAttempts(next: AttemptState) {
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
}

function clearAttempts() {
  try {
    sessionStorage.removeItem(ATTEMPTS_KEY)
  } catch {
    /* ignore */
  }
}

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

/** Network fetch of deploy metadata (never cached by SW). */
export async function fetchServerVersion(): Promise<ServerVersion | null> {
  const res = await fetch(`/version.json?_=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const ct = res.headers.get('content-type') || ''
  if (ct && !ct.includes('json')) return null
  const data = (await res.json()) as Partial<ServerVersion>
  if (!data.buildId || typeof data.buildId !== 'string') return null
  return {
    buildId: data.buildId,
    builtAt: typeof data.builtAt === 'string' ? data.builtAt : undefined,
    deploymentId:
      typeof data.deploymentId === 'string' ? data.deploymentId : undefined,
    vercelEnv: typeof data.vercelEnv === 'string' ? data.vercelEnv : undefined,
  }
}

/**
 * Compare client build ↔ `/version.json`. Reloads when the server is newer.
 * Skipped on localhost / Vite dev.
 */
export async function checkForAppUpdate(opts?: {
  /** When true, ignore prior failed attempts this session. */
  manual?: boolean
}): Promise<'current' | 'updated' | 'skipped' | 'offline'> {
  if (isLocalAppEnv()) return 'skipped'

  try {
    const remote = await fetchServerVersion()
    if (!remote) return 'offline'

    const client = getClientBuildId()
    if (remote.buildId === client) {
      clearAttempts()
      // Drop cache-bust query left by force refresh so shares stay clean.
      try {
        const url = new URL(window.location.href)
        if (url.searchParams.has('_bust')) {
          url.searchParams.delete('_bust')
          window.history.replaceState(
            {},
            '',
            url.pathname + url.search + url.hash,
          )
        }
      } catch {
        /* ignore */
      }
      return 'current'
    }

    if (!opts?.manual) {
      const prev = readAttempts()
      if (prev?.buildId === remote.buildId && prev.count >= MAX_FORCE_ATTEMPTS) {
        logClientInfo(
          'update',
          `New build ${formatBuildLabel(remote.buildId)} already tried ${prev.count}× — open Settings → Force refresh`,
        )
        return 'skipped'
      }
      writeAttempts({
        buildId: remote.buildId,
        count: prev?.buildId === remote.buildId ? prev.count + 1 : 1,
        at: Date.now(),
      })
    } else {
      clearAttempts()
    }

    logClientInfo(
      'update',
      `New build ${formatBuildLabel(remote.buildId)} (client ${formatBuildLabel(client)}) — clearing SW and reloading`,
    )
    await forceAppRefresh()
    return 'updated'
  } catch {
    return 'offline'
  }
}

/**
 * Keep clients on the latest deploy without reload loops:
 * - Poll `/version.json` (NetworkOnly via SW) on wake + every few minutes
 * - On mismatch, unregister SW + clear caches (capped retries per session)
 * - Disabled on localhost / Vite so local work is never yanked
 * - Never force-reload while the cold boot splash is still up
 */
export function startUpdateChecks() {
  if (isLocalAppEnv()) {
    logClientInfo('update', 'Local env — auto update checks disabled')
    return
  }

  try {
    registerSW({
      immediate: true,
      onRegisteredSW(_url, registration) {
        if (!registration) return
        const tick = () => {
          void registration.update().catch(() => {})
        }
        window.setInterval(tick, POLL_MS)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') tick()
        })
        window.addEventListener('focus', tick)
      },
    })
  } catch (err) {
    logClientInfo(
      'update',
      `SW register skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const bootSplashUp = () => Boolean(document.querySelector('[data-boot-splash]'))

  const run = () => {
    if (bootSplashUp()) return
    void checkForAppUpdate()
  }

  // After splash hard-cap (8s) + fade — never yank mid-orbit.
  window.setTimeout(run, 10_000)
  window.setInterval(run, POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  window.addEventListener('focus', run)
  window.addEventListener('pageshow', (ev) => {
    // bfcache restore — treat like a wake.
    if (ev.persisted) run()
  })
}
