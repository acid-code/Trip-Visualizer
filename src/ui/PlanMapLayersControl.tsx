import { useEffect, useRef, useState } from 'react'
import type { PlanSection } from '../domain/types'

type Props = {
  sections: PlanSection[]
  /** Journey / “On the trip” pins — toggled separately from Discover lists. */
  journeySection?: PlanSection | null
  showNearby: boolean
  showJourney?: boolean
  /** Hide Nearby row (Days mode — nearby stays off). */
  hideNearbyToggle?: boolean
  /** Hide Journey row (Days mode — journey stays on). */
  hideJourneyToggle?: boolean
  hiddenSectionIds: Set<string>
  onToggleNearby: () => void
  onToggleJourney?: () => void
  onToggleSection: (sectionId: string) => void
  className?: string
  /** Where the picker opens relative to the FAB */
  panelPlacement?: 'above' | 'below'
}

function LayersGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 12.5 12 17l8.5-4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <path
        d="M3.5 16.5 12 21l8.5-4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        opacity="0.45"
      />
    </svg>
  )
}

/** Plan map layers — Nearby suggestions + saved lists. */
export function PlanMapLayersControl({
  sections,
  journeySection = null,
  showNearby,
  showJourney = true,
  hideNearbyToggle = false,
  hideJourneyToggle = false,
  hiddenSectionIds,
  onToggleNearby,
  onToggleJourney,
  onToggleSection,
  className = '',
  panelPlacement = 'below',
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent | PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`pointer-events-auto relative inline-flex ${className}`}>
      {open ? (
        <div
          className={`map-layers-panel plan-map-layers-panel absolute right-0 z-50 ${
            panelPlacement === 'below' ? 'top-[calc(100%+0.4rem)]' : 'bottom-[calc(100%+0.4rem)]'
          }`}
        >
          <div className="mb-1 px-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            On the map
          </div>
          <div className="flex flex-col gap-0.5">
            {!hideNearbyToggle ? (
              <button
                type="button"
                className={`plan-layer-row ${showNearby ? 'plan-layer-row-on' : ''}`}
                onClick={onToggleNearby}
              >
                <span className="text-sm" aria-hidden>
                  ✨
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-[11px] font-semibold text-[var(--ink)]">Nearby</span>
                  <span className="block text-[9px] text-[var(--ink-muted)]">Suggestions</span>
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${showNearby ? 'bg-[var(--coral)]' : 'bg-[var(--ink-muted)]/35'}`}
                />
              </button>
            ) : null}
            {!hideJourneyToggle && journeySection && onToggleJourney ? (
              <button
                type="button"
                className={`plan-layer-row ${showJourney ? 'plan-layer-row-on' : ''}`}
                onClick={onToggleJourney}
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-xs"
                  style={{ background: `${journeySection.color}33` }}
                  aria-hidden
                >
                  {journeySection.icon || '🗺️'}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[11px] font-semibold text-[var(--ink)]">
                    Journey
                  </span>
                  <span className="block text-[9px] text-[var(--ink-muted)]">On the trip</span>
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${showJourney ? 'bg-[var(--coral)]' : 'bg-[var(--ink-muted)]/35'}`}
                />
              </button>
            ) : null}
            {sections.map((section) => {
              const on = !hiddenSectionIds.has(section.id)
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`plan-layer-row ${on ? 'plan-layer-row-on' : ''}`}
                  onClick={() => onToggleSection(section.id)}
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-xs"
                    style={{ background: `${section.color}33` }}
                    aria-hidden
                  >
                    {section.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-[var(--ink)]">
                    {section.title}
                  </span>
                  <span
                    className={`h-2 w-2 rounded-full ${on ? 'bg-[var(--coral)]' : 'bg-[var(--ink-muted)]/35'}`}
                  />
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className={`map-layers-fab ${open ? 'map-layers-fab-on' : ''}`}
        aria-expanded={open}
        aria-label="Plan map layers"
        title="Map layers"
        onClick={() => setOpen((v) => !v)}
      >
        <LayersGlyph />
      </button>
    </div>
  )
}
