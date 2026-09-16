import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { ItemType, PlanPlace, PlanSection, TripMeta } from '../domain/types'
import { TYPE_EMOJI } from '../domain/types'
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
  /** Fired (debounced) when the map settles — Discover uses center + visible radius. */
  onViewportIdle?: (view: { lat: number; lon: number; radiusM: number }) => void
  /** Journey step type by linked item id — pins use type emoji instead of section icon. */
  linkedItemTypes?: Record<string, ItemType>
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
  linkedItemTypes,
  className = '',
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const lastFitKeyRef = useRef('')
  const lastFocusPlaceRef = useRef<string | null>(null)
  const lastFocusSuggestionRef = useRef<string | null>(null)
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
      const b = map.getBounds()
      const ne = b.getNorthEast()
      const sw = b.getSouthWest()
      // Cover the visible map with a circle from center to farthest corner.
      const radiusM = Math.min(
        50_000,
        Math.max(500, Math.ceil(viewportCornerRadiusM(c.lat, c.lng, ne.lat, ne.lng, sw.lat, sw.lng))),
      )
      onViewportIdleRef.current?.({ lat: c.lat, lon: c.lng, radiusM })
    }
    const onMoveEnd = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(emitIdle, 450)
    }
    map.on('load', emitIdle)
    map.on('moveend', onMoveEnd)
    map.on('resize', onMoveEnd)
    mapRef.current = map
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            map.resize()
            onMoveEnd()
          })
        : null
    if (rootRef.current && ro) ro.observe(rootRef.current)
    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      ro?.disconnect()
      map.off('moveend', onMoveEnd)
      map.off('resize', onMoveEnd)
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
      const isFocus = focusPlaceId != null && focusPlaceId === p.id
      // Focused pin always stays on the map (e.g. Days list pick while a day is filtered).
      if (isFocus) return true
      if (!visibleSectionIds.has(p.sectionId)) return false
      if (visibleDays) {
        // Day filter applies to scheduled / Journey pins; keep unscheduled list ideas visible.
        if (p.scheduledDay && !visibleDays.has(p.scheduledDay)) return false
      }
      return true
    })

    for (const p of visible) {
      const day = p.scheduledDay
      const section = sections.find((s) => s.id === p.sectionId)
      const fill = day
        ? dayColor(meta, day)
        : sectionColor(p.sectionId)
      const dayNum = day ? Math.max(1, dayIndex(meta, day)) : 0
      const linkedType = p.linkedItemId ? linkedItemTypes?.[p.linkedItemId] : undefined
      const emoji = linkedType
        ? TYPE_EMOJI[linkedType] ?? '📍'
        : sectionEmoji(section)
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
      const color = dayColor(meta, day)
      features.push({
        type: 'Feature',
        properties: { day, color },
        geometry: {
          type: 'LineString',
          coordinates: ordered.map((p) => [p.lon!, p.lat!]),
        },
      })
      // Segment badges 2…n sit on the path toward that stop (stop 1 is the pin).
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1]!
        const b = ordered[i]!
        const midLng = (a.lon! + b.lon!) / 2
        const midLat = (a.lat! + b.lat!) / 2
        const num = i + 1
        const badge = document.createElement('div')
        badge.className = 'plan-route-seg-num'
        badge.textContent = String(num)
        badge.title = `Stop ${num}`
        badge.style.setProperty('--plan-route-seg-color', color)
        const marker = new maplibregl.Marker({ element: badge, anchor: 'center' })
          .setLngLat([midLng, midLat])
          .addTo(map)
        markersRef.current.push(marker)
      }
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

    const focusSugChanged = focusSuggestionId !== lastFocusSuggestionRef.current
    lastFocusSuggestionRef.current = focusSuggestionId ?? null
    const focusPlaceChanged = focusPlaceId !== lastFocusPlaceRef.current
    lastFocusPlaceRef.current = focusPlaceId ?? null

    // Only fly when the focused pin actually changes — not when Nearby
    // suggestions refresh after a type filter change.
    if (focusSuggestionId && focusSugChanged) {
      const focus = suggestions.find((s) => s.id === focusSuggestionId)
      if (focus && isValidCoord(focus.lat, focus.lon)) {
        map.easeTo({
          center: [focus.lon, focus.lat],
          zoom: Math.max(map.getZoom(), 12),
          padding: 40,
          duration: 450,
        })
        return
      }
    }
    if (focusPlaceId && focusPlaceChanged) {
      const focus = visible.find((p) => p.id === focusPlaceId)
      if (focus) {
        map.easeTo({
          center: [focus.lon!, focus.lat!],
          zoom: Math.max(map.getZoom(), 11),
          padding: 40,
          duration: 450,
        })
        return
      }
    }

    // Fit once when pins first appear — never yank the camera for filter /
    // Nearby refreshes while the user is looking around.
    const fitKey = `${visible.map((p) => p.id).join(',')}|${hideScheduled}|${[...visibleSectionIds].join(',')}|${
      visibleDays ? [...visibleDays].join(',') : ''
    }`
    if (fitKey === lastFitKeyRef.current) return
    const alreadyFitted = lastFitKeyRef.current !== ''
    lastFitKeyRef.current = fitKey
    if (alreadyFitted) return

    const bounds = new maplibregl.LngLatBounds()
    for (const p of visible) bounds.extend([p.lon!, p.lat!])
    if (bounds.isEmpty()) {
      lastFitKeyRef.current = ''
      return
    }
    map.fitBounds(bounds, {
      padding: 48,
      maxZoom: 12,
      duration: 600,
    })
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
    linkedItemTypes,
  ])

  return (
    <div
      ref={rootRef}
      className={`maplibre-plan-root min-h-0 flex-1 overflow-hidden ${className}`}
    />
  )
}

/** Approx metres from map center to the farthest visible corner. */
function viewportCornerRadiusM(
  clat: number,
  clon: number,
  neLat: number,
  neLon: number,
  swLat: number,
  swLon: number,
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dist = (lat: number, lon: number) => {
    const dLat = toRad(lat - clat)
    const dLon = toRad(lon - clon)
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(clat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
  }
  return Math.max(dist(neLat, neLon), dist(swLat, swLon), dist(neLat, swLon), dist(swLat, neLon))
}
