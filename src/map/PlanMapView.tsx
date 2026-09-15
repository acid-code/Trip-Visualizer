import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { PlanPlace, PlanSection, TripMeta } from '../domain/types'
import { dayColor } from '../data/dayTheme'
import { dayIndex } from '../data/analytics'
import { isValidCoord } from '../data/validate'

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

type Props = {
  meta: TripMeta
  sections: PlanSection[]
  places: PlanPlace[]
  visibleSectionIds: Set<string>
  visibleDays: Set<string> | null
  /** Color pins by section (ideas) or by day (scheduled). */
  colorBy?: 'section' | 'day'
  focusPlaceId?: string | null
  className?: string
}

function makePinEl(opts: {
  fill: string
  label: string
  title: string
  dimmed?: boolean
}): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.title = opts.title
  el.setAttribute('aria-label', opts.title)
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'width:28px',
    'height:28px',
    'margin:0',
    'padding:0',
    'border:0',
    'background:transparent',
    'cursor:pointer',
    opts.dimmed ? 'opacity:0.55' : 'opacity:1',
  ].join(';')

  const bubble = document.createElement('span')
  bubble.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'min-width:22px',
    'height:22px',
    'padding:0 5px',
    'border-radius:999px',
    `background:${opts.fill}`,
    'border:2px solid #0b1220',
    'box-shadow:0 0 0 1px rgba(255,255,255,0.28), 0 6px 14px rgba(0,0,0,0.5)',
    'color:#fff',
    'font:700 10px/1 "Space Grotesk", system-ui, sans-serif',
    'letter-spacing:0.02em',
  ].join(';')
  bubble.textContent = opts.label
  el.appendChild(bubble)
  return el
}

export function PlanMapView({
  meta,
  sections,
  places,
  visibleSectionIds,
  visibleDays,
  colorBy = 'section',
  focusPlaceId,
  className = '',
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])

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
    mapRef.current = map
    return () => {
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
      if (!visibleSectionIds.has(p.sectionId)) return false
      if (visibleDays && p.scheduledDay && !visibleDays.has(p.scheduledDay)) return false
      return true
    })

    for (const p of visible) {
      const day = p.scheduledDay
      const fill =
        colorBy === 'day' && day ? dayColor(meta, day) : sectionColor(p.sectionId)
      const dayNum = day ? Math.max(1, dayIndex(meta, day)) : 0
      const label = day ? String(dayNum) : '·'
      const el = makePinEl({
        fill,
        label,
        title: day ? `${p.name} · day ${dayNum}` : p.name,
        dimmed: !day,
      })
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lon!, p.lat!])
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

    if (focusPlaceId) {
      const focus = visible.find((p) => p.id === focusPlaceId)
      if (focus) {
        map.easeTo({ center: [focus.lon!, focus.lat!], zoom: Math.max(map.getZoom(), 11) })
      }
    } else if (visible.length) {
      const bounds = new maplibregl.LngLatBounds()
      for (const p of visible) bounds.extend([p.lon!, p.lat!])
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 600 })
      }
    }
  }, [meta, sections, places, visibleSectionIds, visibleDays, colorBy, focusPlaceId])

  return (
    <div
      ref={rootRef}
      className={`maplibre-plan-root min-h-0 flex-1 overflow-hidden rounded-2xl border border-[var(--glass-border)] ${className}`}
    />
  )
}
