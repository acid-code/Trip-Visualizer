import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  open: boolean
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

/** First-open Plan coach — colored arrows at Discover/Days, map, and lists. */
export function PlanStartCoach({ open, onDismiss }: Props) {
  const [spots, setSpots] = useState<{
    tabs: Spot | null
    map: Spot | null
    sheet: Spot | null
  }>({ tabs: null, map: null, sheet: null })

  useLayoutEffect(() => {
    if (!open) return

    const measure = () => {
      setSpots({
        tabs: rectSpot(document.querySelector('[data-coach="plan-mode-tabs"]')),
        map: rectSpot(document.querySelector('[data-coach="plan-map"]')),
        sheet: rectSpot(document.querySelector('[data-coach="plan-sheet"]')),
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

  const tabsC = spots.tabs ? centerOf(spots.tabs) : { x: 88, y: 72 }
  const mapC = spots.map
    ? { x: spots.map.x + spots.map.w * 0.55, y: spots.map.y + spots.map.h * 0.42 }
    : { x: vw * 0.55, y: vh * 0.28 }
  const sheetC = spots.sheet
    ? { x: spots.sheet.x + spots.sheet.w * 0.35, y: spots.sheet.y + Math.min(56, spots.sheet.h * 0.28) }
    : { x: vw * 0.4, y: vh * 0.72 }

  const tabsLabel = {
    x: Math.min(vw - 176, Math.max(12, tabsC.x + 28)),
    y: Math.min(vh - 110, Math.max(12, tabsC.y + 44)),
  }
  const mapLabel = {
    x: Math.min(vw - 200, Math.max(12, mapC.x - 100)),
    y: Math.min(vh - 120, Math.max(12, mapC.y + 48)),
  }
  const sheetLabel = {
    x: Math.min(vw - 200, Math.max(12, sheetC.x + 36)),
    y: Math.max(12, Math.min(vh - 140, sheetC.y - 72)),
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[190] animate-[coach-fade_0.35s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-start-coach-title"
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
        aria-label="Dismiss Plan tips"
        onClick={onDismiss}
      />

      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        width={vw}
        height={vh}
        aria-hidden
      >
        <CoachArrow
          from={{ x: tabsLabel.x + 16, y: tabsLabel.y + 8 }}
          to={{ x: tabsC.x, y: tabsC.y + 4 }}
          color="#fb923c"
        />
        <CoachArrow
          from={{ x: mapLabel.x + 96, y: mapLabel.y + 6 }}
          to={{ x: mapC.x, y: mapC.y }}
          color="#2dd4bf"
        />
        <CoachArrow
          from={{ x: sheetLabel.x + 20, y: sheetLabel.y + 40 }}
          to={{ x: sheetC.x, y: sheetC.y }}
          color="#a78bfa"
        />
        <circle cx={tabsC.x} cy={tabsC.y} r="18" fill="none" stroke="#fb923c" strokeWidth="2" opacity="0.55">
          <animate attributeName="r" values="14;22;14" dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="2.2s" repeatCount="indefinite" />
        </circle>
        <circle cx={mapC.x} cy={mapC.y} r="28" fill="none" stroke="#2dd4bf" strokeWidth="2" opacity="0.5">
          <animate attributeName="r" values="22;34;22" dur="2.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.65;0.15;0.65" dur="2.5s" repeatCount="indefinite" />
        </circle>
        <circle cx={sheetC.x} cy={sheetC.y} r="22" fill="none" stroke="#a78bfa" strokeWidth="2" opacity="0.5">
          <animate attributeName="r" values="16;26;16" dur="2.3s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.65;0.2;0.65" dur="2.3s" repeatCount="indefinite" />
        </circle>
      </svg>

      <div
        className="coach-chip pointer-events-none absolute max-w-[11.5rem] rounded-2xl border border-orange-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: tabsLabel.x, top: tabsLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-300">
          Discover · Days
        </p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">
          Collect ideas first, then drop them into day buckets
        </p>
      </div>

      <div
        className="coach-chip pointer-events-none absolute max-w-[12.5rem] rounded-2xl border border-teal-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: mapLabel.x, top: mapLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-300">Map</p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">
          Tap pins for details · layers hide lists & nearby
        </p>
      </div>

      <div
        className="coach-chip pointer-events-none absolute max-w-[12.5rem] rounded-2xl border border-violet-300/50 bg-[#0f1a24]/92 px-3 py-2 text-left shadow-xl backdrop-blur"
        style={{ left: sheetLabel.x, top: sheetLabel.y }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">Lists</p>
        <p className="mt-0.5 text-xs leading-snug text-white/90">
          Save must-sees here, then schedule them on Days
        </p>
      </div>

      <div className="pointer-events-auto absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] flex justify-center px-4">
        <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-[var(--paper)] px-5 py-4 text-center text-[var(--ink)] shadow-2xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--coral-deep)]">
            Plan mode
          </p>
          <h2 id="plan-start-coach-title" className="brand-mark mt-1 text-xl">
            Sketch the trip first
          </h2>
          <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
            Discover ideas on the map, park them in lists, then order days — Journey adds times
            later.
          </p>
          <button
            type="button"
            className="mt-3 w-full rounded-full bg-[var(--coral)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--coral-deep)]"
            onClick={onDismiss}
          >
            Got it — let’s plan
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
