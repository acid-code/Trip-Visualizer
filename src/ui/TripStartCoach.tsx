import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  open: boolean
  tripName?: string
  onDismiss: () => void
}

type Spot = { x: number; y: number; w: number; h: number }

function rectSpot(el: Element | null): Spot | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 && r.height < 2) return null
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function centerOf(s: Spot): { x: number; y: number } {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 }
}

/** Curved arrow from near a label toward a target point. */
function CoachArrow({
  from,
  to,
  color,
}: {
  from: { x: number; y: number }
  to: { x: number; y: number }
  color: string
}) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const cx = from.x + dx * 0.45 - dy * 0.18
  const cy = from.y + dy * 0.45 + dx * 0.12
  const d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
  const angle = Math.atan2(to.y - cy, to.x - cx)
  const head = 11
  const a1 = angle + Math.PI * 0.82
  const a2 = angle - Math.PI * 0.82

  return (
    <g className="coach-arrow">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeDasharray="5 6"
        opacity="0.95"
      />
      <path
        d={`M ${to.x} ${to.y} L ${to.x + Math.cos(a1) * head} ${to.y + Math.sin(a1) * head} L ${to.x + Math.cos(a2) * head} ${to.y + Math.sin(a2) * head} Z`}
        fill={color}
      />
    </g>
  )
}

export function TripStartCoach({ open, tripName, onDismiss }: Props) {
  const [spots, setSpots] = useState<{
    search: Spot | null
    steps: Spot | null
    map: Spot | null
  }>({ search: null, steps: null, map: null })

  useLayoutEffect(() => {
    if (!open) return

    const measure = () => {
      setSpots({
        search: rectSpot(document.querySelector('[data-coach="map-search"]')),
        steps: rectSpot(document.querySelector('[data-coach="trip-steps"]')),
        map: rectSpot(document.querySelector('[data-coach="globe-map"]')),
      })
    }

    measure()
    const t = window.setTimeout(measure, 80)
    const t2 = window.setTimeout(measure, 320)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(t2)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const vw = window.innerWidth
  const vh = window.innerHeight

  const searchC = spots.search ? centerOf(spots.search) : { x: 56, y: 56 }
  const stepsC = spots.steps
    ? centerOf(spots.steps)
    : { x: Math.min(180, vw * 0.28), y: vh * 0.45 }
  const mapC = spots.map
    ? { x: spots.map.x + spots.map.w * 0.58, y: spots.map.y + spots.map.h * 0.42 }
    : { x: vw * 0.55, y: vh * 0.42 }

  // Label anchors sit away from targets so arrows have room to breathe
  const searchLabel = {
    x: Math.min(vw - 168, Math.max(12, searchC.x + 36)),
    y: Math.min(vh - 100, Math.max(12, searchC.y + 48)),
  }
  const pinLabel = {
    x: Math.min(vw - 200, Math.max(12, mapC.x - 90)),
    y: Math.min(vh - 120, Math.max(12, mapC.y + 56)),
  }
  const stepsLabel = {
    x: Math.min(vw - 200, Math.max(12, stepsC.x + (spots.steps && spots.steps.w > 120 ? 24 : 40))),
    y: Math.min(vh - 120, Math.max(12, stepsC.y - 8)),
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[190] animate-[coach-fade_0.35s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trip-start-coach-title"
    >
      <style>{`
        @keyframes coach-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes coach-bob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        .coach-arrow path {
          animation: coach-bob 2.4s ease-in-out infinite;
        }
        .coach-chip {
          animation: coach-bob 2.6s ease-in-out infinite;
        }
        .coach-chip:nth-of-type(2) { animation-delay: 0.2s; }
        .coach-chip:nth-of-type(3) { animation-delay: 0.4s; }
      `}</style>

      <button
        type="button"
        className="absolute inset-0 bg-[#0c1520]/55 backdrop-blur-[1px]"
        aria-label="Dismiss getting started tips"
        onClick={onDismiss}
      />

      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        width={vw}
        height={vh}
        aria-hidden
      >
        <CoachArrow
          from={{ x: searchLabel.x + 20, y: searchLabel.y + 8 }}
          to={{ x: searchC.x, y: searchC.y + 6 }}
          color="#fb923c"
        />
        <CoachArrow
          from={{ x: pinLabel.x + 100, y: pinLabel.y + 6 }}
          to={{ x: mapC.x, y: mapC.y }}
          color="#2dd4bf"
        />
        <CoachArrow
          from={{ x: stepsLabel.x + 24, y: stepsLabel.y + 36 }}
          to={{ x: stepsC.x, y: stepsC.y }}
          color="#a78bfa"
        />
        {/* soft pulse rings on targets */}
        <circle cx={searchC.x} cy={searchC.y} r="18" fill="none" stroke="#fb923c" strokeWidth="2" opacity="0.55">
          <animate attributeName="r" values="14;22;14" dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="2.2s" repeatCount="indefinite" />
        </circle>
        <circle cx={mapC.x} cy={mapC.y} r="28" fill="none" stroke="#2dd4bf" strokeWidth="2" opacity="0.5">
          <animate attributeName="r" values="22;34;22" dur="2.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.65;0.15;0.65" dur="2.5s" repeatCount="indefinite" />
        </circle>
        <circle cx={stepsC.x} cy={stepsC.y} r="22" fill="none" stroke="#a78bfa" strokeWidth="2" opacity="0.5">
          <animate attributeName="r" values="16;26;16" dur="2.3s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.65;0.2;0.65" dur="2.3s" repeatCount="indefinite" />
        </circle>
      </svg>

      <div
        className="coach-chip pointer-events-none absolute max-w-[11rem] rounded-2xl border border-orange-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: searchLabel.x, top: searchLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-300">Search</p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">Find a place, address, or paste a Maps link</p>
      </div>

      <div
        className="coach-chip pointer-events-none absolute max-w-[12.5rem] rounded-2xl border border-teal-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: pinLabel.x, top: pinLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-300">Long-press</p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">Hold on the map to drop a pin where you are</p>
      </div>

      <div
        className="coach-chip pointer-events-none absolute max-w-[12.5rem] rounded-2xl border border-violet-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: stepsLabel.x, top: stepsLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">Base steps</p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">Tap a day base to set your hotel or arrival</p>
      </div>

      <div className="pointer-events-auto absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] flex justify-center px-4">
        <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-[var(--paper)] px-5 py-4 text-center text-[var(--ink)] shadow-2xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--coral-deep)]">
            Ready to explore
          </p>
          <h2 id="trip-start-coach-title" className="brand-mark mt-1 text-xl">
            {tripName ? `“${tripName}” is set` : 'Your trip is set'}
          </h2>
          <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
            Start with search, a long-press pin, or by filling in a base day — arrows show where.
          </p>
          <button
            type="button"
            className="mt-3 w-full rounded-full bg-[var(--coral)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--coral-deep)]"
            onClick={onDismiss}
          >
            Got it — let’s go
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
