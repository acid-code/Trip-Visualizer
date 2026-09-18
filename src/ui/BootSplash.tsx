import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  /** IndexedDB / settings boot finished. */
  dataReady: boolean
  /** Visible map (Journey globe or Plan MapLibre) has painted once. */
  mapReady: boolean
  /** Initial drive/walk path hydrate finished (or nothing to draw). */
  routesReady: boolean
}

/** One full anti-clockwise revolution. */
const ORBIT_MS = 1800
const ORBIT_REDUCED_MS = 280
const ESCAPE_MS = 780
/** Hard cap — must not reset when map/routes readiness flaps during boot. */
const MAX_SHOW_MS = 8_000
const FADE_MS = 420

type Phase = 'orbit' | 'escape' | 'out' | 'gone'

/**
 * Cold-boot mark: mountain + three moons on a shared circular orbit.
 * Moons keep circling until the shell is ready, then fling outward and fade.
 */
export function BootSplash({ dataReady, mapReady, routesReady }: Props) {
  const [mountedAt] = useState(() => performance.now())
  const [phase, setPhase] = useState<Phase>('orbit')
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const shellReady = dataReady && mapReady && routesReady

  // Uncancellable wall clock — routes/map toggling must not extend the splash forever.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setPhase((p) => (p === 'orbit' ? 'escape' : p))
    }, MAX_SHOW_MS)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (phase !== 'orbit') return
    if (!shellReady) return
    const minOrbit = reducedMotion ? ORBIT_REDUCED_MS : ORBIT_MS
    const wait = Math.max(0, minOrbit - (performance.now() - mountedAt))
    const t = window.setTimeout(() => setPhase('escape'), wait)
    return () => window.clearTimeout(t)
  }, [shellReady, phase, mountedAt, reducedMotion])

  useEffect(() => {
    if (phase !== 'escape') return
    const t = window.setTimeout(
      () => setPhase('out'),
      reducedMotion ? 120 : ESCAPE_MS,
    )
    return () => window.clearTimeout(t)
  }, [phase, reducedMotion])

  useEffect(() => {
    if (phase !== 'out') return
    const t = window.setTimeout(() => setPhase('gone'), FADE_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  useEffect(() => {
    if (phase === 'gone') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [phase])

  if (phase === 'gone') return null

  const escaping = phase === 'escape' || phase === 'out'

  return createPortal(
    <div
      className={`boot-splash${phase === 'out' ? ' boot-splash-out' : ''}${
        escaping ? ' boot-splash-escaping' : ''
      }`}
      role="status"
      aria-live="polite"
      aria-label="Loading Trip Tracker"
      data-boot-splash=""
    >
      <div className="boot-splash-mark" aria-hidden>
        <svg className="boot-splash-mountain" viewBox="0 0 64 64">
          <path
            d="M18 40c8-18 20-18 28 0"
            stroke="#34d399"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        {/* Shared orbit center = mark center; moons sit on equal 120° radii. */}
        <div className={`boot-moons${escaping ? ' boot-moons-escape' : ''}`}>
          <span className="boot-moon boot-moon-a" />
          <span className="boot-moon boot-moon-b" />
          <span className="boot-moon boot-moon-c" />
        </div>
      </div>
      <p className="boot-splash-title brand-mark">Trip Tracker</p>
    </div>,
    document.body,
  )
}
