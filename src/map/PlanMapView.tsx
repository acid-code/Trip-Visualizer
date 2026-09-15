import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { PlanPlace, PlanSection, TripMeta } from '../domain/types'
import { dayColor } from '../data/dayTheme'
import { dayIndex } from '../data/analytics'
import { isValidCoord } from '../data/validate'

setWorkerUrl(maplibreWorkerUrl)

/** Esri Dark Gray Canvas — free public tiles, no API key (unlike Carto). */
const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'esri-dark': {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Esri, HERE, Garmin, © OpenStreetMap',
    },
  },
  layers: [
    {
      id: 'esri-dark',
      type: 'raster',
      source: 'esri-dark',
      minzoom: 0,
      maxzoom: 16,
    },
  ],
}

export type PlanSuggestionPin = {
  id: string
  lat: number
  lon: number
  name: string
  /** Type emoji shown inside the map circle. */
  emoji?: string
}

type Props = {
  meta: TripMeta
  sections: PlanSection[]
  places: PlanPlace[]
  visibleSectionIds: Set<string>
  visibleDays: Set<string> | null
  /** Color pins by section (ideas) or by day (scheduled). */
  colorBy?: 'section' | 'day'
  /** When true, hide/dim scheduled places (Discover mode). */
  hideScheduled?: boolean
  suggestions?: PlanSuggestionPin[]
  focusPlaceId?: string | null
  focusSuggestionId?: string | null
  onPlaceClick?: (placeId: string) => void
  onSuggestionClick?: (suggestionId: string) => void
  /** Fired (debounced) when the map settles — Discover uses this as the Nearby anchor. */
  onViewportIdle?: (center: { lat: number; lon: number }) => void
  className?: string
}

function makePinEl(opts: {
  fill: string
  emoji: string
  title: string
  dimmed?: boolean
  ring?: string
  selected?: boolean
}): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.title = opts.title
  el.setAttribute('aria-label', opts.title)
  const size = opts.selected ? 34 : 30
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    `width:${size}px`,
    `height:${size}px`,
    'margin:0',
    'padding:0',
    'border:0',
    'background:transparent',
    'cursor:pointer',
    opts.dimmed ? 'opacity:0.4' : 'opacity:1',
  ].join(';')

  const bubble = document.createElement('span')
  bubble.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    `width:${size}px`,
    `height:${size}px`,
    'border-radius:999px',
    `background:${opts.fill}`,
    `border:2.5px solid ${opts.ring || (opts.selected ? '#fff' : '#0b1220')}`,
    opts.selected
      ? 'box-shadow:0 0 0 2px rgba(251,191,36,0.9), 0 8px 18px rgba(0,0,0,0.55)'
      : 'box-shadow:0 0 0 1px rgba(255,255,255,0.28), 0 6px 14px rgba(0,0,0,0.5)',
    'font-size:14px',
    'line-height:1',
  ].join(';')
  bubble.textContent = opts.emoji
  el.appendChild(bubble)
  return el
}

function sectionEmoji(section: PlanSection | undefined): string {
  const icon = section?.icon?.trim() || ''
  // Prefer section icon when it looks like an emoji (not a letter/digit glyph).
  if (icon && !/^[a-z0-9#@]+$/i.test(icon) && icon.length <= 4) return icon
  const t = (section?.title || '').toLowerCase()
  if (t.includes('food') || t.includes('eat') || t.includes('drink')) return '🍽️'
  if (t.includes('stay') || t.includes('hotel')) return '🛏️'
  if (t.includes('nature') || t.includes('outdoor')) return '🌿'
  if (t.includes('must') || t.includes('sight')) return '🏛️'
  if (t.includes('maybe') || t.includes('optional')) return '✨'
  return '📍'
}

export function PlanMapView({
  meta,
  sections,
  places,
  visibleSectionIds,
  visibleDays,
  colorBy = 'section',
  hideScheduled = false,
  suggestions = [],
  focusPlaceId,
  focusSuggestionId,
  onPlaceClick,
  onSuggestionClick,
  onViewportIdle,
  className = '',
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const lastFitKeyRef = useRef('')
  const onPlaceClickRef = useRef(onPlaceClick)
  const onSuggestionClickRef = useRef(onSuggestionClick)
  const onViewportIdleRef = useRef(onViewportIdle)
  onPlaceClickRef.current = onPlaceClick
  onSuggestionClickRef.current = onSuggestionClick
  onViewportIdleRef.current = onViewportIdle

  useEffect(() => {
    if (!rootRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: rootRef.current,
      style: DARK_STYLE,
      center: [5.2, 43.7],
      zoom: 7.2,
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const emitIdle = () => {
      const c = map.getCenter()
      onViewportIdleRef.current?.({ lat: c.lat, lon: c.lng })
    }
    const onMoveEnd = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(emitIdle, 450)
    }
    map.on('load', emitIdle)
    map.on('moveend', onMoveEnd)
    mapRef.current = map
    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      map.off('moveend', onMoveEnd)
      for (const m of markersRef.current) m.remove()
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const m of markersRef.current) m.remove()
    markersRef.current = []

    const sectionColor = (sectionId: string) =>
      sections.find((s) => s.id === sectionId)?.color || '#60a5fa'

    const visible = places.filter((p) => {
      if (!isValidCoord(p.lat, p.lon)) return false
      if (hideScheduled && p.scheduledDay) return false
      if (!visibleSectionIds.has(p.sectionId)) return false
      if (visibleDays) {
        if (!p.scheduledDay || !visibleDays.has(p.scheduledDay)) return false
      }
      return true
    })

    for (const p of visible) {
      const day = p.scheduledDay
      const section = sections.find((s) => s.id === p.sectionId)
      const fill =
        colorBy === 'day' && day ? dayColor(meta, day) : sectionColor(p.sectionId)
      const dayNum = day ? Math.max(1, dayIndex(meta, day)) : 0
      const emoji = sectionEmoji(section)
      const el = makePinEl({
        fill,
        emoji,
        title: day ? `${p.name} · day ${dayNum}` : p.name,
        dimmed: false,
        selected: focusPlaceId === p.id,
      })
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onPlaceClickRef.current?.(p.id)
      })
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lon!, p.lat!])
        .addTo(map)
      markersRef.current.push(marker)
    }

    for (const s of suggestions) {
      if (!isValidCoord(s.lat, s.lon)) continue
      const el = makePinEl({
        fill: '#f59e0b',
        emoji: s.emoji || '✨',
        title: `Suggestion · ${s.name}`,
        ring: focusSuggestionId === s.id ? '#fde68a' : '#92400e',
        selected: focusSuggestionId === s.id,
      })
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onSuggestionClickRef.current?.(s.id)
      })
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([s.lon, s.lat])
        .addTo(map)
      markersRef.current.push(marker)
    }

    const byDay = new globalThis.Map<string, PlanPlace[]>()
    for (const p of visible) {
      if (!p.scheduledDay) continue
      const list = byDay.get(p.scheduledDay) || []
      list.push(p)
      byDay.set(p.scheduledDay, list)
    }

    const sourceId = 'plan-day-routes'
    const features: GeoJSON.Feature[] = []
    for (const [day, list] of byDay) {
      const ordered = [...list].sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
      if (ordered.length < 2) continue
      features.push({
        type: 'Feature',
        properties: { day, color: dayColor(meta, day) },
        geometry: {
          type: 'LineString',
          coordinates: ordered.map((p) => [p.lon!, p.lat!]),
        },
      })
    }

    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
    const ensure = () => {
      if (map.getSource(sourceId)) {
        ;(map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data)
      } else {
        map.addSource(sourceId, { type: 'geojson', data })
        map.addLayer({
          id: 'plan-day-routes-line',
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': '#38bdf8',
            'line-width': 2.5,
            'line-opacity': 0.75,
          },
        })
      }
    }
    if (map.isStyleLoaded()) ensure()
    else map.once('load', ensure)

    if (focusSuggestionId) {
      const focus = suggestions.find((s) => s.id === focusSuggestionId)
      if (focus && isValidCoord(focus.lat, focus.lon)) {
        map.easeTo({ center: [focus.lon, focus.lat], zoom: Math.max(map.getZoom(), 12) })
        return
      }
    }
    if (focusPlaceId) {
      const focus = visible.find((p) => p.id === focusPlaceId)
      if (focus) {
        map.easeTo({ center: [focus.lon!, focus.lat!], zoom: Math.max(map.getZoom(), 11) })
        return
      }
    }

    // Fit to trip pins only — not suggestions (avoids Discover re-fetch loops on pan).
    const fitKey = `${visible.map((p) => p.id).join(',')}|${hideScheduled}|${[...visibleSectionIds].join(',')}|${
      visibleDays ? [...visibleDays].join(',') : ''
    }`
    if (fitKey === lastFitKeyRef.current) return
    lastFitKeyRef.current = fitKey

    const bounds = new maplibregl.LngLatBounds()
    for (const p of visible) bounds.extend([p.lon!, p.lat!])
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 56, maxZoom: 12, duration: 600 })
    }
  }, [
    meta,
    sections,
    places,
    visibleSectionIds,
    visibleDays,
    colorBy,
    hideScheduled,
    suggestions,
    focusPlaceId,
    focusSuggestionId,
  ])

  return (
    <div
      ref={rootRef}
      className={`maplibre-plan-root min-h-0 flex-1 overflow-hidden ${className}`}
    />
  )
}
