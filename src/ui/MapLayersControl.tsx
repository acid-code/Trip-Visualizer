import { useEffect, useRef, useState } from 'react'
import type { MapLook, MapStack } from '../globe/viewer'

type Props = {
  mapLook: MapLook
  mapStack: MapStack
  googleKeyConfigured: boolean
  onLookChange: (look: MapLook) => void
  onStackChange: (stack: MapStack) => void
  className?: string
  /** Where the picker opens relative to the FAB */
  panelPlacement?: 'above' | 'below'
}

const LOOKS: Array<{ id: MapLook; label: string; swatch: string; blurb: string }> = [
  {
    id: 'realistic',
    label: 'Realistic',
    swatch:
      'linear-gradient(145deg, #1a3a2a 0%, #4a7c59 35%, #c4a574 70%, #2d5a4a 100%)',
    blurb: 'Satellite & 3D',
  },
  {
    id: 'modern',
    label: 'Modern',
    swatch: 'linear-gradient(145deg, #1a1f2e 0%, #2a3348 45%, #4a5568 100%)',
    blurb: 'Dark canvas',
  },
]

const STACKS: Array<{ id: MapStack; label: string; swatch: string }> = [
  {
    id: 'esri',
    label: 'Esri',
    swatch: 'linear-gradient(160deg, #0b3d2e, #6b8f71 40%, #c9a66b)',
  },
  {
    id: 'osm',
    label: 'OSM',
    swatch: 'linear-gradient(160deg, #dce8d4, #a8c4a0 50%, #7a9e6e)',
  },
  {
    id: 'google3d',
    label: '3D',
    swatch: 'linear-gradient(160deg, #1e3a5f, #4a90c8 45%, #e8c48a)',
  },
]

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

export function MapLayersControl({
  mapLook,
  mapStack,
  googleKeyConfigured,
  onLookChange,
  onStackChange,
  className = '',
  panelPlacement = 'above',
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
          className={`map-layers-panel absolute right-0 z-50 ${
            panelPlacement === 'below' ? 'top-[calc(100%+0.5rem)]' : 'bottom-[calc(100%+0.5rem)]'
          }`}
        >
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
            Map look
          </div>
          <div className="mb-3 flex gap-2">
            {LOOKS.map((look) => (
              <button
                key={look.id}
                type="button"
                className={`map-layer-card ${mapLook === look.id ? 'map-layer-card-on' : ''}`}
                onClick={() => onLookChange(look.id)}
              >
                <div className="map-layer-swatch" style={{ background: look.swatch }} />
                {look.label}
                <div className="mt-0.5 text-[9px] font-medium normal-case tracking-normal text-[var(--ink-muted)]">
                  {look.blurb}
                </div>
              </button>
            ))}
          </div>

          {mapLook === 'realistic' ? (
            <>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                Basemap
              </div>
              <div className="flex gap-2">
                {STACKS.map((s) => {
                  const disabled = s.id === 'google3d' && !googleKeyConfigured
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={disabled}
                      title={
                        disabled ? 'Add a Google Maps key in Settings for Photoreal 3D' : s.label
                      }
                      className={`map-layer-card disabled:opacity-40 ${
                        mapStack === s.id ? 'map-layer-card-on' : ''
                      }`}
                      onClick={() => onStackChange(s.id)}
                    >
                      <div className="map-layer-swatch" style={{ background: s.swatch }} />
                      {s.label}
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <p className="text-[11px] leading-snug text-[var(--ink-muted)]">
              Modern uses Esri dark canvas — no API key needed.
            </p>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className={`map-layers-fab ${open ? 'map-layers-fab-on' : ''}`}
        aria-expanded={open}
        aria-label="Map layers"
        title="Map layers"
        onClick={() => setOpen((v) => !v)}
      >
        <LayersGlyph />
      </button>
    </div>
  )
}
