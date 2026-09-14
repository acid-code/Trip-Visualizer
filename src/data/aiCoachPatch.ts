/** Apply grounded Day Coach patches without mutating other days. */

import type { TripItem, TripRecord } from '../domain/types'
import { createId, sortItems, nowIso } from './db'
import { ensureDayStartBases, itemTouchesDay, isPlaceholderBase } from './dayBases'
import {
  explorePlaceToItemType,
  explorePlaceTripMeta,
  type ExplorePlace,
} from './explore'
import { normalizeCurrency } from './fx'
import { isValidCoord } from './validate'
import type { AiCoachOption, AiCoachPatch } from './aiCoachTypes'

function cloneItem(item: TripItem): TripItem {
  return {
    ...item,
    tags: [...(item.tags ?? [])],
    routeCoords: item.routeCoords ? item.routeCoords.map((c) => [...c] as [number, number]) : [],
  }
}

function itemFingerprint(item: TripItem): string {
  const { routeCoords: _r, updatedAt: _u, ...rest } = item
  return JSON.stringify(rest)
}

export type PatchApplyResult =
  | {
      ok: true
      items: TripItem[]
      addedIds: string[]
      changedIds: string[]
      removedIds: string[]
    }
  | { ok: false; error: string }

const REMOVABLE_CONTENT = new Set([
  'sight',
  'restaurant',
  'activity',
  'note',
  'other',
  'city',
  'drive',
])

const PROTECTED_TYPES = new Set([
  'flight',
  'hotel',
  'train',
  'bus',
  'ferry',
])

function isVehicleish(item: TripItem): boolean {
  return /dealer|dealership|rental|rent-a-car|avis|hertz|sixt|europcar|enterprise|car\s*hire|pick\s*up|car\s*pickup/i.test(
    `${item.title} ${item.place} ${item.notes}`,
  )
}

function canCoachRemove(item: TripItem): boolean {
  // Day-base shells may be removed / replaced when the coach fills the day
  if (isPlaceholderBase(item)) return true
  if (PROTECTED_TYPES.has(item.type)) return false
  if (isVehicleish(item)) return false
  return REMOVABLE_CONTENT.has(item.type)
}

function pointOf(item: TripItem): { lat: number; lon: number } | null {
  if (isValidCoord(item.lat, item.lon)) return { lat: item.lat!, lon: item.lon! }
  if (isValidCoord(item.latTo, item.lonTo)) {
    return { lat: item.latTo!, lon: item.lonTo! }
  }
  return null
}

/**
 * After removing content stops, also drop same-day drives that only existed
 * to reach those stops (otherwise trim feels like a no-op on the timeline/map).
 */
function pruneOrphanDrivesAfterRemove(
  items: TripItem[],
  day: string,
  removed: TripItem[],
): { items: TripItem[]; extraRemovedIds: string[] } {
  if (!removed.length) return { items, extraRemovedIds: [] }
  const removedIds = new Set(removed.map((r) => r.id))
  const targets = removed.filter((r) => r.type !== 'drive')
  if (!targets.length) return { items, extraRemovedIds: [] }

  const titleBits = targets.map((t) =>
    `${t.title} ${t.place}`.toLowerCase().replace(/\s+/g, ' ').trim(),
  )
  const coords = targets.map(pointOf).filter(Boolean) as {
    lat: number
    lon: number
  }[]

  const extraRemovedIds: string[] = []
  const next = items.filter((i) => {
    if (removedIds.has(i.id)) return false
    if (!itemTouchesDay(i, day) || i.type !== 'drive') return true

    const blob = `${i.title} ${i.from} ${i.to}`.toLowerCase()
    const to = (i.to || '').toLowerCase().trim()
    if (
      titleBits.some((t) => {
        if (!t || t.length < 3) return false
        if (blob.includes(t)) return true
        if (to.length >= 3 && (t.includes(to) || to.includes(t.slice(0, 24)))) {
          return true
        }
        return false
      })
    ) {
      extraRemovedIds.push(i.id)
      return false
    }

    const end =
      isValidCoord(i.latTo, i.lonTo)
        ? { lat: i.latTo!, lon: i.lonTo! }
        : null
    const start =
      isValidCoord(i.lat, i.lon) ? { lat: i.lat!, lon: i.lon! } : null
    for (const c of coords) {
      if (end && haversineKm(end, c) < 1.2) {
        extraRemovedIds.push(i.id)
        return false
      }
      if (start && haversineKm(start, c) < 1.2) {
        extraRemovedIds.push(i.id)
        return false
      }
    }
    return true
  })

  return { items: next, extraRemovedIds }
}

function emptyNote(
  day: string,
  currency: string,
  title: string,
  notes: string,
  start?: string,
): TripItem {
  return {
    id: createId('N'),
    type: 'note',
    title,
    place: '',
    city: '',
    date: day,
    endDate: '',
    start: start || '',
    end: '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency,
    status: 'planned',
    notes,
    url: '',
    tags: ['ai-coach'],
    lat: null,
    lon: null,
    latTo: null,
    lonTo: null,
    wikidata: '',
    osmId: '',
    rating: null,
    googleMapsUri: '',
    geocodeQuery: '',
    updatedAt: nowIso(),
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
  }
}

function placeToItem(
  place: ExplorePlace,
  day: string,
  currency: string,
  start?: string,
  end?: string,
  note?: string,
): TripItem {
  // Day Coach must never invent lodging stays. Hotel-tagged places that slip
  // through (e.g. a hotel restaurant) become restaurant/other steps instead.
  let type = explorePlaceToItemType(place)
  if (type === 'hotel') {
    const primary = (place.tags.primaryType || '').toLowerCase()
    const foodish =
      place.category === 'food' ||
      place.category === 'drink' ||
      /restaurant|cafe|bakery|bar|food|meal/i.test(primary) ||
      /lunch|dinner|café|cafe|breakfast|brunch|pub|meal/i.test(note || '')
    type = foodish ? 'restaurant' : 'other'
  }
  const meta = explorePlaceTripMeta(place)
  return {
    id: createId('S'),
    type,
    title: place.name,
    place: place.address || place.name,
    city: '',
    date: day,
    endDate: '',
    start: start || '',
    end: end || '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency,
    status: 'planned',
    notes: note || place.summary || '',
    url: place.website || '',
    tags: place.cuisine ? [place.cuisine, 'ai-coach'] : ['ai-coach'],
    lat: place.lat,
    lon: place.lon,
    latTo: null,
    lonTo: null,
    wikidata: place.wikidata || '',
    osmId: place.osmId || '',
    rating: meta.rating,
    googleMapsUri: meta.googleMapsUri,
    geocodeQuery: place.name,
    updatedAt: nowIso(),
    enrichmentSummary: place.summary || place.address || '',
    enrichmentImage: place.images[0] || '',
    enrichmentSource: meta.enrichmentSource,
    routeCoords: [],
    source: 'app',
  }
}

function driveBetweenStops(
  from: TripItem,
  to: TripItem,
  day: string,
  currency: string,
  start?: string,
  end?: string,
): TripItem | null {
  const fromLat = isValidCoord(from.latTo, from.lonTo)
    ? from.latTo!
    : isValidCoord(from.lat, from.lon)
      ? from.lat!
      : null
  const fromLon = isValidCoord(from.latTo, from.lonTo)
    ? from.lonTo!
    : isValidCoord(from.lat, from.lon)
      ? from.lon!
      : null
  if (fromLat == null || fromLon == null) return null
  if (!isValidCoord(to.lat, to.lon)) return null
  return {
    id: createId('D'),
    type: 'drive',
    title: `Drive to ${to.title || to.place || 'stop'}`,
    place: '',
    city: '',
    date: day,
    endDate: '',
    start: start || '',
    end: end || '',
    from: from.title || from.place || 'Start',
    to: to.title || to.place || 'Stop',
    confirm: '',
    cost: null,
    currency,
    status: 'planned',
    notes: 'Suggested by Day Coach',
    url: '',
    tags: ['ai-coach', 'ai-coach-stitch'],
    lat: fromLat,
    lon: fromLon,
    latTo: to.lat,
    lonTo: to.lon,
    wikidata: '',
    osmId: '',
    rating: null,
    googleMapsUri: '',
    geocodeQuery: '',
    updatedAt: nowIso(),
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
  }
}

function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}

function pointLatLon(item: TripItem): { lat: number; lon: number } | null {
  if (isValidCoord(item.lat, item.lon)) return { lat: item.lat!, lon: item.lon! }
  if (isValidCoord(item.latTo, item.lonTo))
    return { lat: item.latTo!, lon: item.lonTo! }
  return null
}

function dayCoordPoints(dayItems: TripItem[]): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = []
  for (const i of dayItems) {
    if (i.status === 'cancelled' || i.type === 'note' || isPlaceholderBase(i)) {
      continue
    }
    const p = pointOf(i)
    if (p) out.push(p)
  }
  return out
}

/**
 * Open countryside / multi-village day (Provence-style) vs compact city pocket.
 * Sparse hops and road-trip cues → open area (prefer drives even for ~2 km).
 */
export function isOpenAreaTravelDay(
  dayItems: TripItem[],
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  if (dayItems.some(isVehicleish)) return true
  if (dayItems.some((i) => i.type === 'drive')) return true

  const blob = dayItems
    .map((i) => `${i.title} ${i.place} ${i.city} ${i.notes}`)
    .join(' ')
  if (
    /provence|luberon|tuscany|umbria|dordogne|countryside|vineyard|winery|wine\s*cellar|village|hamlet|agriturismo|farm\s*stay|gordes|rousillon|bonnieux|ménerbes|lourmarin/i.test(
      blob,
    )
  ) {
    return true
  }

  const pts = dayCoordPoints(dayItems)
  // Include the hop endpoints so a fresh AI add still has geometry
  const all = [...pts, a, b]
  let diameter = 0
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      diameter = Math.max(diameter, haversineKm(all[i]!, all[j]!))
    }
  }
  // Spread day-trip → open area
  if (diameter >= 10) return true

  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
  const near = all.filter((p) => haversineKm(p, mid) <= 1.6).length
  const hop = haversineKm(a, b)
  // Only a couple of pins around this hop → villages / countryside, not a city grid
  if (near <= 2 && hop >= 1.2) return true

  return false
}

/**
 * AI auto travel: city + under 3 km → walk (map connectors); open area → drive
 * even around 2 km; skip tiny same-complex hops.
 */
export function aiLegTravelMode(
  distKm: number,
  dayItems: TripItem[],
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): 'walk' | 'drive' | 'none' {
  if (!Number.isFinite(distKm) || distKm < 0.12 || distKm > 200) return 'none'
  if (isOpenAreaTravelDay(dayItems, a, b)) {
    return distKm < 0.8 ? 'none' : 'drive'
  }
  if (distKm < 3) return 'walk'
  return 'drive'
}

/** Min distance (km) before Day Coach should propose an explicit drive to a candidate. */
export function aiAutoDriveMinKm(
  dayItems: TripItem[],
  anchor: { lat: number; lon: number },
  place: { lat: number; lon: number },
): number {
  return isOpenAreaTravelDay(dayItems, anchor, place) ? 1 : 3
}

function earlierHmDrive(hm: string, minutes: number): string {
  const [h, m] = hm.split(':').map(Number)
  const total = Math.max(0, (h || 0) * 60 + (m || 0) - minutes)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function laterHmDrive(hm: string, minutes: number): string {
  const [h, m] = hm.split(':').map(Number)
  const total = Math.min(23 * 60 + 59, (h || 0) * 60 + (m || 0) + minutes)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Build stop-to-stop drives for a day's addSteps (not a star from the hotel).
 * First far hop may leave from fromItemId (vehicle/hotel); later hops use fromCandidateId.
 */
export function chainDrivesForSteps(
  steps: NonNullable<AiCoachOption['patch']['addSteps']>,
  candidates: ExplorePlace[],
  opts: {
    dayItems: TripItem[]
    fromItemId?: string
    openArea?: boolean
  },
): NonNullable<AiCoachOption['patch']['addDrives']> {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const sorted = [...steps].sort((a, b) =>
    (a.start || '99:99').localeCompare(b.start || '99:99'),
  )
  if (sorted.length < 1) return []

  const minKm = opts.openArea ? 1 : 3
  const daySnap = opts.dayItems
  const out: NonNullable<AiCoachOption['patch']['addDrives']> = []

  let prevId: string | null = null
  let prevPlace: ExplorePlace | null = null
  let prevArrive = ''

  for (const s of sorted) {
    const place = byId.get(s.candidateId)
    if (!place || !isValidCoord(place.lat, place.lon)) continue
    const arrive = s.start || '12:00'

    if (!prevPlace) {
      if (place.distKm >= minKm) {
        out.push({
          fromItemId: opts.fromItemId,
          toCandidateId: place.id,
          start: earlierHmDrive(arrive, 45),
          end: arrive,
        })
      }
    } else {
      const d = haversineKm(
        { lat: prevPlace.lat, lon: prevPlace.lon },
        { lat: place.lat, lon: place.lon },
      )
      const shouldDrive =
        opts.openArea != null
          ? d >= (opts.openArea ? 0.8 : 3)
          : aiLegTravelMode(
              d,
              daySnap,
              { lat: prevPlace.lat, lon: prevPlace.lon },
              { lat: place.lat, lon: place.lon },
            ) === 'drive'
      if (shouldDrive) {
        // Leave after the previous stop so Drive sorts between stops, not before them
        let start = laterHmDrive(prevArrive || arrive, 15)
        if (start >= arrive) start = earlierHmDrive(arrive, 20)
        out.push({
          fromCandidateId: prevId!,
          toCandidateId: place.id,
          start,
          end: arrive,
        })
      }
    }
    prevId = place.id
    prevPlace = place
    prevArrive = arrive
  }
  return out
}

const STITCHABLE = new Set([
  'hotel',
  'sight',
  'restaurant',
  'activity',
  'city',
  'other',
])

/**
 * Insert drive legs between consecutive same-day stops when the hop needs a car.
 * Compact city hops under 3 km stay walk-only (existing map walk connectors).
 * Open / Provence-style days get drives even for ~2 km village hops.
 */
function stitchMissingDayDrives(
  items: TripItem[],
  day: string,
  currency: string,
  addedIds: string[],
): TripItem[] {
  const dayItems = sortItems(
    items.filter(
      (i) =>
        itemTouchesDay(i, day) &&
        !isPlaceholderBase(i) &&
        i.status !== 'cancelled' &&
        i.type !== 'note',
    ),
  )
  const stops = dayItems.filter((i) => STITCHABLE.has(i.type))
  if (stops.length < 2) return items

  const drives = dayItems.filter((i) => i.type === 'drive')
  const inserts: TripItem[] = []

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i]!
    const to = stops[i + 1]!
    // Only bridge gaps that involve newly added stops (don't invent drives for old plan)
    const touchesNew =
      addedIds.includes(from.id) || addedIds.includes(to.id)
    if (!touchesNew) continue
    const a = pointLatLon(from)
    const b = pointLatLon(to)
    if (!a || !b) continue
    const d = haversineKm(a, b)
    const mode = aiLegTravelMode(d, dayItems, a, b)
    if (mode !== 'drive') continue

    // One inbound drive to this stop is enough (avoids hotel→X plus wrong dinner→X)
    const covered = drives.some((dr) => {
      if (!isValidCoord(dr.latTo, dr.lonTo)) return false
      return haversineKm({ lat: dr.latTo!, lon: dr.lonTo! }, b) < 3
    })
    if (covered) continue

    // Prefer a start time just before the destination stop
    let start = ''
    if (to.start && /^\d{2}:\d{2}$/.test(to.start)) {
      const [hh, mm] = to.start.split(':').map(Number)
      const mins = Math.max(0, (hh || 0) * 60 + (mm || 0) - 45)
      start = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    } else if (from.start) {
      start = from.start
    }

    const leg = driveBetweenStops(from, to, day, currency, start || undefined)
    if (!leg) continue
    inserts.push(leg)
    addedIds.push(leg.id)
  }

  if (!inserts.length) return items
  return sortItems([...items, ...inserts])
}

function driveToPlace(
  from: TripItem,
  place: ExplorePlace,
  day: string,
  currency: string,
  start?: string,
  end?: string,
): TripItem | null {
  const fromLat = isValidCoord(from.latTo, from.lonTo)
    ? from.latTo!
    : isValidCoord(from.lat, from.lon)
      ? from.lat!
      : null
  const fromLon = isValidCoord(from.latTo, from.lonTo)
    ? from.lonTo!
    : isValidCoord(from.lat, from.lon)
      ? from.lon!
      : null
  if (fromLat == null || fromLon == null) return null
  if (!isValidCoord(place.lat, place.lon)) return null
  return {
    id: createId('D'),
    type: 'drive',
    title: `Drive to ${place.name}`,
    place: '',
    city: '',
    date: day,
    endDate: '',
    start: start || '',
    end: end || '',
    from: from.title || from.place || 'Start',
    to: place.name,
    confirm: '',
    cost: null,
    currency,
    status: 'planned',
    notes: 'Suggested by Day Coach',
    url: '',
    tags: ['ai-coach'],
    lat: fromLat,
    lon: fromLon,
    latTo: place.lat,
    lonTo: place.lon,
    wikidata: '',
    osmId: '',
    rating: null,
    googleMapsUri: '',
    geocodeQuery: '',
    updatedAt: nowIso(),
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
  }
}

function resolveDriveFrom(
  working: TripItem[],
  day: string,
  fromItemId: string | undefined,
  /** Prefer these items for “day start” (pre-patch hotel/vehicle) — not newly added stops. */
  dayStartPool?: TripItem[],
): TripItem | null {
  if (fromItemId) {
    const hit = working.find((i) => i.id === fromItemId && itemTouchesDay(i, day))
    if (hit) return hit
  }

  const poolSource = dayStartPool ?? working
  const dayItems = poolSource.filter(
    (i) =>
      itemTouchesDay(i, day) &&
      !isPlaceholderBase(i) &&
      i.status !== 'cancelled' &&
      i.type !== 'drive' &&
      i.type !== 'note',
  )
  const vehicle = dayItems.find((i) =>
    /dealer|dealership|rental|rent-a-car|avis|hertz|sixt|europcar|enterprise|car\s*hire|pick\s*up/i.test(
      `${i.title} ${i.place}`,
    ),
  )
  if (vehicle) return vehicle

  const hotel = dayItems.find(
    (i) =>
      i.type === 'hotel' &&
      (isValidCoord(i.lat, i.lon) || isValidCoord(i.latTo, i.lonTo)),
  )
  if (hotel) return hotel

  // Earliest existing stop — never the last (that wrongly became dinner after addSteps-first)
  const sorted = sortItems(dayItems)
  for (const it of sorted) {
    if (isValidCoord(it.lat, it.lon) || isValidCoord(it.latTo, it.lonTo)) return it
  }

  // Placeholders only if nothing else
  const base = poolSource.find(
    (i) =>
      isPlaceholderBase(i) &&
      i.date === day &&
      (isValidCoord(i.lat, i.lon) || isValidCoord(i.latTo, i.lonTo)),
  )
  return base ?? null
}

/** Resolve a prior patch stop (by candidate id / coords) as the departure for the next drive. */
function resolveDriveFromCandidate(
  working: TripItem[],
  day: string,
  fromCandidateId: string,
  byCandidate: Map<string, ExplorePlace>,
): TripItem | null {
  const place = byCandidate.get(fromCandidateId)
  if (!place || !isValidCoord(place.lat, place.lon)) return null
  const dayItems = working.filter(
    (i) =>
      itemTouchesDay(i, day) &&
      i.type !== 'drive' &&
      i.status !== 'cancelled' &&
      !isPlaceholderBase(i),
  )
  const hit = dayItems.find(
    (i) =>
      isValidCoord(i.lat, i.lon) &&
      Math.abs(i.lat! - place.lat) < 1e-4 &&
      Math.abs(i.lon! - place.lon) < 1e-4,
  )
  return hit ?? null
}

/**
 * When the coach populates a day that only had a “Day N base” shell, turn that
 * shell into the first real stop (keep id) and remove other placeholders on the day.
 */
function absorbDayPlaceholders(
  working: TripItem[],
  day: string,
  addedIds: string[],
): {
  working: TripItem[]
  removedIds: string[]
  changedIds: string[]
  idMap: Map<string, string>
} {
  const removedIds: string[] = []
  const changedIds: string[] = []
  const idMap = new Map<string, string>()
  const placeholders = working.filter(
    (i) => isPlaceholderBase(i) && i.date === day,
  )
  if (!placeholders.length) {
    return { working, removedIds, changedIds, idMap }
  }

  const addedSet = new Set(addedIds)
  const newStops = sortItems(
    working.filter(
      (i) =>
        addedSet.has(i.id) &&
        i.type !== 'drive' &&
        i.type !== 'note' &&
        !isPlaceholderBase(i),
    ),
  )

  let next = working

  if (newStops.length) {
    const ph = placeholders[0]!
    const first = newStops[0]!
    const upgraded: TripItem = {
      ...cloneItem(first),
      id: ph.id,
      tags: (first.tags ?? []).filter(
        (t) => t !== 'placeholder' && t !== 'day-base',
      ),
      updatedAt: nowIso(),
    }
    if (!upgraded.tags.includes('ai-coach')) upgraded.tags = [...upgraded.tags, 'ai-coach']
    next = working.filter((i) => i.id !== ph.id && i.id !== first.id)
    // Drop any other bases on this day
    for (const p of placeholders.slice(1)) {
      next = next.filter((i) => i.id !== p.id)
      removedIds.push(p.id)
    }
    next.push(upgraded)
    idMap.set(first.id, ph.id)
    changedIds.push(ph.id)
  } else {
    // Drives/notes only: still clear empty day shells so they don't stay as fake hotels
    for (const p of placeholders) {
      next = next.filter((i) => i.id !== p.id)
      removedIds.push(p.id)
    }
  }

  return { working: next, removedIds, changedIds, idMap }
}

/** Apply patch; only selected-day items may change. */
export function applyCoachPatch(args: {
  trip: TripRecord
  day: string
  patch: AiCoachPatch
  candidates: ExplorePlace[]
}): PatchApplyResult {
  const { trip, day, patch, candidates } = args
  const byCandidate = new Map(candidates.map((c) => [c.id, c]))
  const before = trip.items.map(cloneItem)
  const beforeById = new Map(before.map((i) => [i.id, i]))

  let working = before.map(cloneItem)
  const addedIds: string[] = []
  const changedIds: string[] = []
  const removedIds: string[] = []
  const currency = normalizeCurrency(trip.meta.homeCurrency || 'EUR')

  if (patch.removeSteps?.length) {
    const removedSnapshot: TripItem[] = []
    for (const rm of patch.removeSteps) {
      const item = working.find((i) => i.id === rm.itemId)
      if (!item) continue
      if (!itemTouchesDay(item, day)) {
        return { ok: false, error: 'Patch tried to remove a step on another day' }
      }
      // Soft-skip protected/skeleton steps so a bad Gemini id doesn't abort the whole trim
      if (!canCoachRemove(item)) continue
      removedSnapshot.push(cloneItem(item))
      working = working.filter((i) => i.id !== rm.itemId)
      removedIds.push(rm.itemId)
    }
    const pruned = pruneOrphanDrivesAfterRemove(working, day, removedSnapshot)
    working = pruned.items
    removedIds.push(...pruned.extraRemovedIds)
  }

  if (patch.setTimes?.length) {
    for (const st of patch.setTimes) {
      const idx = working.findIndex((i) => i.id === st.itemId)
      if (idx < 0) continue
      const item = working[idx]!
      if (!itemTouchesDay(item, day)) {
        return { ok: false, error: 'Patch tried to change a step on another day' }
      }
      if (isPlaceholderBase(item)) continue
      const next = cloneItem(item)
      if (st.start !== undefined) next.start = st.start
      if (st.end !== undefined) next.end = st.end
      next.updatedAt = nowIso()
      working[idx] = next
      changedIds.push(next.id)
    }
  }

  if (patch.addSteps?.length) {
    for (const add of patch.addSteps) {
      const place = byCandidate.get(add.candidateId)
      if (!place) {
        return { ok: false, error: `Unknown candidate ${add.candidateId}` }
      }
      const dup = working.some(
        (i) =>
          itemTouchesDay(i, day) &&
          i.type !== 'drive' &&
          isValidCoord(i.lat, i.lon) &&
          Math.abs(i.lat! - place.lat) < 1e-4 &&
          Math.abs(i.lon! - place.lon) < 1e-4,
      )
      if (dup) continue
      const item = placeToItem(place, day, currency, add.start, add.end, add.note)
      working.push(item)
      addedIds.push(item.id)
    }
  }

  if (patch.addDrives?.length) {
    for (const d of patch.addDrives) {
      const place = byCandidate.get(d.toCandidateId)
      if (!place) {
        return { ok: false, error: `Unknown drive destination ${d.toCandidateId}` }
      }
      const from = d.fromCandidateId
        ? resolveDriveFromCandidate(working, day, d.fromCandidateId, byCandidate) ??
          resolveDriveFrom(working, day, d.fromItemId, before)
        : resolveDriveFrom(working, day, d.fromItemId, before)
      if (!from) {
        return { ok: false, error: 'No valid departure point for suggested drive' }
      }
      const fromPt = pointLatLon(from)
      if (fromPt && isValidCoord(place.lat, place.lon)) {
        const daySnap = working.filter((i) => itemTouchesDay(i, day))
        const mode = aiLegTravelMode(
          haversineKm(fromPt, { lat: place.lat, lon: place.lon }),
          daySnap,
          fromPt,
          { lat: place.lat, lon: place.lon },
        )
        // City short hops: skip explicit drive — walk connectors cover them
        if (mode === 'walk' || mode === 'none') continue
      }
      const leg = driveToPlace(from, place, day, currency, d.start, d.end)
      if (!leg) {
        return { ok: false, error: 'Could not build drive leg (missing coordinates)' }
      }
      working.push(leg)
      addedIds.push(leg.id)
    }
  }

  // Always materialize drive destinations as stops (addSteps may have been
  // promised but skipped as "dup", leaving a drive with no restaurant/sight).
  if (patch.addDrives?.length) {
    for (const d of patch.addDrives) {
      const place = byCandidate.get(d.toCandidateId)
      if (!place || !isValidCoord(place.lat, place.lon)) continue
      const exists = working.some(
        (i) =>
          itemTouchesDay(i, day) &&
          i.type !== 'drive' &&
          isValidCoord(i.lat, i.lon) &&
          Math.abs(i.lat! - place.lat) < 1e-4 &&
          Math.abs(i.lon! - place.lon) < 1e-4,
      )
      if (exists) continue
      const dest = placeToItem(
        place,
        day,
        currency,
        d.end || undefined,
        undefined,
        'Stop at end of suggested drive',
      )
      working.push(dest)
      addedIds.push(dest.id)
    }
  }

  if (patch.addNote?.title) {
    const note = emptyNote(
      day,
      currency,
      patch.addNote.title,
      patch.addNote.notes || '',
      patch.addNote.start,
    )
    working.push(note)
    addedIds.push(note.id)
  }

  // Empty-day bases → real steps: upgrade the Day N shell into the first new stop
  // (same id), and drop any leftover placeholders on this day.
  if (addedIds.length) {
    const absorbed = absorbDayPlaceholders(working, day, addedIds)
    working = absorbed.working
    for (const id of absorbed.removedIds) {
      if (!removedIds.includes(id)) removedIds.push(id)
    }
    for (const id of absorbed.changedIds) {
      if (!changedIds.includes(id)) changedIds.push(id)
    }
    // Rewrite addedIds if the first stop reused a placeholder id
    for (let i = 0; i < addedIds.length; i++) {
      const mapped = absorbed.idMap.get(addedIds[i]!)
      if (mapped) addedIds[i] = mapped
    }
  }

  // Far stops (e.g. Provence lunch/dinner) need drive legs or the map stays pin-only
  working = stitchMissingDayDrives(working, day, currency, addedIds)

  const withBases = ensureDayStartBases(trip.meta, sortItems(working))

  for (const item of withBases) {
    if (itemTouchesDay(item, day)) continue
    const prev = beforeById.get(item.id)
    if (!prev) {
      if (!isPlaceholderBase(item)) {
        return { ok: false, error: 'Patch created a step outside the coached day' }
      }
      return { ok: false, error: 'Patch altered another day’s placeholders' }
    }
  }

  for (const prev of before) {
    if (itemTouchesDay(prev, day)) continue
    const next = withBases.find((i) => i.id === prev.id)
    if (!next) {
      return { ok: false, error: 'Patch removed a step from another day' }
    }
    if (itemFingerprint(prev) !== itemFingerprint(next)) {
      return { ok: false, error: 'Patch mutated a step on another day' }
    }
  }

  return { ok: true, items: withBases, addedIds, changedIds, removedIds }
}

export function assertOtherDaysIntact(
  before: TripItem[],
  after: TripItem[],
  day: string,
): string | null {
  const beforeById = new Map(before.map((i) => [i.id, i]))
  for (const prev of before) {
    if (itemTouchesDay(prev, day)) continue
    const next = after.find((i) => i.id === prev.id)
    if (!next) return 'Missing step from another day'
    if (itemFingerprint(prev) !== itemFingerprint(next)) {
      return `Changed step “${prev.title}” on another day`
    }
  }
  for (const item of after) {
    if (itemTouchesDay(item, day)) continue
    if (!beforeById.has(item.id) && !isPlaceholderBase(item)) {
      return 'New step appeared on another day'
    }
  }
  return null
}

export function describePatch(
  option: AiCoachOption,
  candidates: ExplorePlace[],
  dayItems?: Array<{ id: string; title: string }>,
): string[] {
  const lines: string[] = []
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const byItem = new Map((dayItems ?? []).map((i) => [i.id, i.title]))

  type TimedLine = { t: string; line: string }
  const timed: TimedLine[] = []

  const driveFromLabel = (
    d: NonNullable<AiCoachOption['patch']['addDrives']>[number],
  ): string => {
    if (d.fromCandidateId) {
      return byId.get(d.fromCandidateId)?.name ?? 'previous stop'
    }
    if (d.fromItemId) {
      return byItem.get(d.fromItemId) ?? 'day start'
    }
    return 'day start'
  }

  for (const d of option.patch.addDrives ?? []) {
    const p = byId.get(d.toCandidateId)
    timed.push({
      t: d.start || d.end || '99:99',
      line: `Drive from ${driveFromLabel(d)} → ${p?.name ?? d.toCandidateId}${
        d.start ? ` @ ${d.start}` : ''
      }`,
    })
  }
  for (const a of option.patch.addSteps ?? []) {
    const p = byId.get(a.candidateId)
    timed.push({
      t: a.start || '99:99',
      line: `Add ${p?.name ?? a.candidateId}${a.start ? ` @ ${a.start}` : ''}`,
    })
  }
  timed.sort((a, b) => a.t.localeCompare(b.t))
  for (const row of timed) lines.push(row.line)

  for (const t of option.patch.setTimes ?? []) {
    const title = byItem.get(t.itemId) || `${t.itemId.slice(0, 8)}…`
    lines.push(`Retimed “${title}”${t.start ? ` → ${t.start}` : ''}`)
  }
  for (const r of option.patch.removeSteps ?? []) {
    const title = byItem.get(r.itemId) || `${r.itemId.slice(0, 8)}…`
    lines.push(`Remove “${title}”`)
  }
  if (option.patch.addNote) {
    lines.push(`Note: ${option.patch.addNote.title}`)
  }
  return lines
}

/** Earliest added step with coords (by start time). */
export function earliestNewSpot(
  items: TripItem[],
  addedIds: string[],
): TripItem | null {
  const set = new Set(addedIds)
  const added = items
    .filter((i) => set.has(i.id))
    .filter((i) => isValidCoord(i.lat, i.lon) || isValidCoord(i.latTo, i.lonTo))
  if (!added.length) return null
  return sortItems(added)[0] ?? null
}

export function newSpotsForOverview(
  items: TripItem[],
  addedIds: string[],
): TripItem[] {
  const set = new Set(addedIds)
  return items.filter(
    (i) =>
      set.has(i.id) &&
      (isValidCoord(i.lat, i.lon) || isValidCoord(i.latTo, i.lonTo)),
  )
}
