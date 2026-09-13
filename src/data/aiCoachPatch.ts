/** Apply grounded Day Coach patches without mutating other days. */

import type { TripItem, TripRecord } from '../domain/types'
import { createId, sortItems, nowIso } from './db'
import { ensureDayStartBases, itemTouchesDay, isPlaceholderBase } from './dayBases'
import {
  explorePlaceToItemType,
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
  if (isPlaceholderBase(item)) return false
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
  return {
    id: createId('S'),
    type: explorePlaceToItemType(place),
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
    geocodeQuery: place.name,
    updatedAt: nowIso(),
    enrichmentSummary: place.summary || place.address || '',
    enrichmentImage: place.images[0] || '',
    enrichmentSource: place.wikidata ? 'Wikidata' : 'OpenStreetMap',
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

const STITCHABLE = new Set([
  'hotel',
  'sight',
  'restaurant',
  'activity',
  'city',
  'other',
])

/**
 * Insert drive legs between consecutive same-day stops that are too far to walk.
 * Keeps Provence-style AI adds from appearing as disconnected pins.
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
    if (d <= 8 || d > 200) continue

    const covered = drives.some((dr) => {
      if (!isValidCoord(dr.lat, dr.lon) || !isValidCoord(dr.latTo, dr.lonTo)) {
        return false
      }
      const startNear =
        haversineKm({ lat: dr.lat!, lon: dr.lon! }, a) < 3
      const endNear =
        haversineKm({ lat: dr.latTo!, lon: dr.lonTo! }, b) < 3
      return startNear && endNear
    })
    if (covered) continue

    // Prefer a start time just before the destination stop
    let start = ''
    if (to.start && /^\d{2}:\d{2}$/.test(to.start)) {
      const [hh, mm] = to.start.split(':').map(Number)
      const mins = Math.max(0, (hh || 0) * 60 + (mm || 0) - 60)
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
): TripItem | null {
  if (fromItemId) {
    const hit = working.find((i) => i.id === fromItemId && itemTouchesDay(i, day))
    if (hit) return hit
  }
  const dayItems = working.filter(
    (i) => itemTouchesDay(i, day) && !isPlaceholderBase(i) && i.status !== 'cancelled',
  )
  const vehicle = dayItems.find((i) =>
    /dealer|dealership|rental|rent-a-car|avis|hertz|sixt|europcar|enterprise|car\s*hire|pick\s*up/i.test(
      `${i.title} ${i.place}`,
    ),
  )
  if (vehicle) return vehicle
  const sorted = sortItems(dayItems)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const it = sorted[i]!
    if (isValidCoord(it.lat, it.lon) || isValidCoord(it.latTo, it.lonTo)) return it
  }
  return null
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

  if (patch.addDrives?.length) {
    for (const d of patch.addDrives) {
      const place = byCandidate.get(d.toCandidateId)
      if (!place) {
        return { ok: false, error: `Unknown drive destination ${d.toCandidateId}` }
      }
      const from = resolveDriveFrom(working, day, d.fromItemId)
      if (!from) {
        return { ok: false, error: 'No valid departure point for suggested drive' }
      }
      const leg = driveToPlace(from, place, day, currency, d.start, d.end)
      if (!leg) {
        return { ok: false, error: 'Could not build drive leg (missing coordinates)' }
      }
      working.push(leg)
      addedIds.push(leg.id)
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
  for (const d of option.patch.addDrives ?? []) {
    const p = byId.get(d.toCandidateId)
    const from = d.fromItemId ? byItem.get(d.fromItemId) : 'day start'
    lines.push(
      `Drive ${from ? `from ${from} ` : ''}→ ${p?.name ?? d.toCandidateId}${d.start ? ` @ ${d.start}` : ''}`,
    )
  }
  for (const a of option.patch.addSteps ?? []) {
    const p = byId.get(a.candidateId)
    lines.push(
      `Add ${p?.name ?? a.candidateId}${a.start ? ` @ ${a.start}` : ''}`,
    )
  }
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
