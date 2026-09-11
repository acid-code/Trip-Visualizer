import type { TripItem } from '../domain/types'
import { isPlaceholderBase, itemTouchesDay } from './dayBases'
import { sortItems } from './db'
import { getCachedRoute, routeCacheKey, setCachedRoute } from './routeCache'
import { isValidCoord } from './validate'

const OSRM_DRIVE = 'https://router.project-osrm.org/route/v1/driving'
const OSRM_FOOT = 'https://router.project-osrm.org/route/v1/foot'

export type RouteConnector = {
  id: string
  mode: 'drive' | 'walk'
  fromItemId: string
  toItemId: string
  date: string
  coords: [number, number][]
  /** 1-based order within that calendar day among connectors+legs */
  sequenceInDay?: number
}

function pointOf(item: TripItem): { lat: number; lon: number } | null {
  if (isValidCoord(item.lat, item.lon)) return { lat: item.lat!, lon: item.lon! }
  return null
}

/** Prefer stay location for hotels; for legs use arrival (to) when connecting onward. */
function anchorForDaySequence(
  item: TripItem,
  role: 'arrive' | 'depart',
): { lat: number; lon: number } | null {
  if (
    item.type === 'flight' ||
    item.type === 'train' ||
    item.type === 'bus' ||
    item.type === 'ferry' ||
    item.type === 'drive'
  ) {
    if (role === 'arrive' && isValidCoord(item.latTo, item.lonTo)) {
      return { lat: item.latTo!, lon: item.lonTo! }
    }
    if (role === 'depart' && isValidCoord(item.lat, item.lon)) {
      return { lat: item.lat!, lon: item.lon! }
    }
  }
  return pointOf(item)
}

export async function fetchOsrmRoute(
  from: [number, number],
  to: [number, number],
  profile: 'driving' | 'foot',
): Promise<[number, number][]> {
  const key = routeCacheKey(profile, from, to)
  const cached = await getCachedRoute(key)
  if (cached && cached.length >= 2) return cached

  const base = profile === 'foot' ? OSRM_FOOT : OSRM_DRIVE
  const url = `${base}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`
  try {
    const res = await fetch(url)
    if (!res.ok) return [from, to]
    const json = (await res.json()) as {
      code?: string
      routes?: Array<{ geometry?: { coordinates?: [number, number][] } }>
    }
    if (json.code && json.code !== 'Ok') return [from, to]
    const coords = json.routes?.[0]?.geometry?.coordinates
    if (!coords?.length) return [from, to]
    const latLon = coords.map(([lon, lat]) => [lat, lon] as [number, number])
    void setCachedRoute(key, profile, latLon)
    return latLon
  } catch {
    return [from, to]
  }
}

/** Fill missing drive polylines via OSRM. */
export async function hydrateDriveRoutes(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<TripItem[]> {
  const drives = items.filter(
    (i) =>
      i.type === 'drive' &&
      i.status !== 'cancelled' &&
      isValidCoord(i.lat, i.lon) &&
      isValidCoord(i.latTo, i.lonTo) &&
      (!i.routeCoords || i.routeCoords.length < 2),
  )
  if (!drives.length) return items

  const map = new Map(items.map((i) => [i.id, i]))
  let done = 0
  for (const drive of drives) {
    const coords = await fetchOsrmRoute(
      [drive.lat!, drive.lon!],
      [drive.latTo!, drive.lonTo!],
      'driving',
    )
    map.set(drive.id, { ...drive, routeCoords: coords })
    done += 1
    onProgress?.(done, drives.length)
    await new Promise((r) => setTimeout(r, 120))
  }
  return items.map((i) => map.get(i.id) ?? i)
}

const POINTISH = new Set([
  'hotel',
  'sight',
  'restaurant',
  'activity',
  'city',
  'other',
])

/**
 * Walking connectors between consecutive same-day steps (by time order),
 * plus hotel → first activity when a stay covers that morning.
 */
export async function buildWalkingConnectors(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<RouteConnector[]> {
  const sorted = sortItems(
    items.filter(
      (i) => i.status !== 'cancelled' && i.type !== 'note' && !isPlaceholderBase(i),
    ),
  )
  const byDate = new Map<string, TripItem[]>()
  for (const item of sorted) {
    if (!byDate.has(item.date)) byDate.set(item.date, [])
    byDate.get(item.date)!.push(item)
  }

  const pairs: Array<{
    id: string
    date: string
    from: TripItem
    to: TripItem
    a: { lat: number; lon: number }
    b: { lat: number; lon: number }
  }> = []
  const seen = new Set<string>()

  function addPair(
    date: string,
    from: TripItem,
    to: TripItem,
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
    maxKm: number,
  ) {
    const id = `walk:${from.id}->${to.id}`
    if (seen.has(id)) return
    const d = distKm(a, b)
    if (d < 0.05 || d > maxKm) return
    seen.add(id)
    pairs.push({ id, date, from, to, a, b })
  }

  for (const [date, dayItems] of byDate) {
    const daySteps = sortItems(dayItems)

    // Morning hotel (overnight stay, or earliest same-day check-in) → first step after it
    const hotel = hotelForMorning(sorted, date)
    if (hotel) {
      const firstAfterHotel = firstStepAfterMorningHotel(daySteps, hotel, date)
      if (firstAfterHotel) {
        const a = pointOf(hotel)
        const b = pointOf(firstAfterHotel)
        if (a && b) addPair(date, hotel, firstAfterHotel, a, b, 8)
      }
    }

    // Consecutive same-calendar-day steps
    for (let i = 0; i < daySteps.length - 1; i++) {
      const from = daySteps[i]!
      const to = daySteps[i + 1]!

      if (
        to.type === 'drive' ||
        to.type === 'flight' ||
        to.type === 'train' ||
        to.type === 'bus' ||
        to.type === 'ferry'
      ) {
        continue
      }

      if (
        from.type === 'drive' ||
        from.type === 'flight' ||
        from.type === 'train' ||
        from.type === 'bus' ||
        from.type === 'ferry'
      ) {
        const a = anchorForDaySequence(from, 'arrive')
        const b = pointOf(to)
        if (!a || !b) continue
        addPair(date, from, to, a, b, 12)
        continue
      }

      if (!POINTISH.has(from.type) || !POINTISH.has(to.type)) continue
      const a = pointOf(from)
      const b = pointOf(to)
      if (!a || !b) continue
      addPair(date, from, to, a, b, 8)
    }
  }

  const connectors: RouteConnector[] = []
  let done = 0
  for (const pair of pairs) {
    const coords = await fetchOsrmRoute(
      [pair.a.lat, pair.a.lon],
      [pair.b.lat, pair.b.lon],
      'foot',
    )
    connectors.push({
      id: pair.id,
      mode: 'walk',
      fromItemId: pair.from.id,
      toItemId: pair.to.id,
      date: pair.date,
      coords,
      sequenceInDay: done + 1,
    })
    done += 1
    onProgress?.(done, pairs.length)
    await new Promise((r) => setTimeout(r, 120))
  }
  return connectors
}

/**
 * Hotel you're in at the start of the day:
 * 1) Stay that began on a previous day and still covers this morning
 * 2) Else earliest same-day check-in (before an afternoon hotel change)
 */
function hotelForMorning(items: TripItem[], day: string): TripItem | null {
  const hotels = items.filter(
    (i) =>
      i.type === 'hotel' &&
      i.status !== 'cancelled' &&
      !isPlaceholderBase(i) &&
      itemTouchesDay(i, day) &&
      pointOf(i),
  )
  if (!hotels.length) return null

  const overnight = hotels
    .filter((h) => h.date < day && !!h.endDate && h.endDate >= day)
    .sort((a, b) => b.date.localeCompare(a.date)) // most recent prior check-in
  if (overnight[0]) return overnight[0]

  // Same-day check-ins only — earliest time is the morning hotel
  const sameDay = sortItems(hotels.filter((h) => h.date === day))
  return sameDay[0] ?? null
}

/** First walkable step after the morning hotel (never an afternoon hotel or earlier activity). */
function firstStepAfterMorningHotel(
  daySteps: TripItem[],
  hotel: TripItem,
  day: string,
): TripItem | null {
  const isTransport = (t: TripItem['type']) =>
    t === 'drive' || t === 'flight' || t === 'train' || t === 'bus' || t === 'ferry'

  // Overnight hotel isn't in today's list — walk to the first activity today
  if (hotel.date < day) {
    return (
      daySteps.find(
        (i) => i.type !== 'hotel' && !isTransport(i.type),
      ) ?? null
    )
  }

  // Same-day morning hotel — only steps that come after it in the timeline
  const idx = daySteps.findIndex((i) => i.id === hotel.id)
  const after = idx >= 0 ? daySteps.slice(idx + 1) : daySteps
  return (
    after.find(
      (i) => i.type !== 'hotel' && !isTransport(i.type),
    ) ?? null
  )
}

export function distKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

/** Sum of great-circle segments along a [lat, lon] polyline. */
export function pathLengthKm(coords: [number, number][]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!
    const b = coords[i]!
    total += distKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] })
  }
  return total
}

/** Rough walking ETA at ~5 km/h from path length (null if too short / empty). */
export function estimateWalkMinutes(coords: [number, number][]): number | null {
  if (coords.length < 2) return null
  const km = pathLengthKm(coords)
  if (!(km > 0.02)) return null
  return Math.max(1, Math.round((km / 5) * 60))
}

/** Rough driving ETA at ~45 km/h mixed roads (null if too short / empty). */
export function estimateDriveMinutes(coords: [number, number][]): number | null {
  if (coords.length < 2) return null
  const km = pathLengthKm(coords)
  if (!(km > 0.05)) return null
  return Math.max(1, Math.round((km / 45) * 60))
}

export type NearbyStepLink = {
  itemId: string
  title: string
  date: string
  distKm: number
  lat: number
  lon: number
  coords: [number, number][]
}

/**
 * Foot paths from an origin to the nearest trip pins (within maxKm).
 * Used for temp-pin “closeness” previews on the globe.
 */
export async function nearbyWalkLinks(
  origin: { lat: number; lon: number },
  items: TripItem[],
  opts?: { maxKm?: number; limit?: number },
): Promise<NearbyStepLink[]> {
  const maxKm = opts?.maxKm ?? 3
  const limit = opts?.limit ?? 4

  const candidates: Array<{
    itemId: string
    title: string
    date: string
    distKm: number
    lat: number
    lon: number
  }> = []

  for (const item of items) {
    if (item.status === 'cancelled' || item.type === 'note') continue
    if (isPlaceholderBase(item)) continue

    const points: Array<{ lat: number; lon: number; label: string }> = []
    if (isValidCoord(item.lat, item.lon)) {
      points.push({
        lat: item.lat!,
        lon: item.lon!,
        label: item.title || item.place || 'Step',
      })
    }
    if (isValidCoord(item.latTo, item.lonTo)) {
      points.push({
        lat: item.latTo!,
        lon: item.lonTo!,
        label: `${item.title || 'Step'} (to)`,
      })
    }

    for (const p of points) {
      const d = distKm(origin, p)
      if (d < 0.02 || d > maxKm) continue
      candidates.push({
        itemId: item.id,
        title: p.label,
        date: item.date,
        distKm: d,
        lat: p.lat,
        lon: p.lon,
      })
    }
  }

  candidates.sort((a, b) => a.distKm - b.distKm)

  // One link per step (prefer closer endpoint)
  const bestByItem = new Map<string, (typeof candidates)[0]>()
  for (const c of candidates) {
    if (!bestByItem.has(c.itemId)) bestByItem.set(c.itemId, c)
  }
  const top = [...bestByItem.values()].sort((a, b) => a.distKm - b.distKm).slice(0, limit)

  const links: NearbyStepLink[] = []
  for (const c of top) {
    const coords = await fetchOsrmRoute(
      [origin.lat, origin.lon],
      [c.lat, c.lon],
      'foot',
    )
    links.push({
      ...c,
      coords: coords.length >= 2 ? coords : [[origin.lat, origin.lon], [c.lat, c.lon]],
    })
  }
  return links
}

/** Prefer day filter, else the majority date among nearby pins (≥ half). */
export function suggestDateFromNearby(
  dayFilter: string | null | undefined,
  links: Array<{ date: string }>,
  fallback: string,
): string {
  if (dayFilter && /^\d{4}-\d{2}-\d{2}$/.test(dayFilter)) return dayFilter
  const dates = links.map((l) => l.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  if (!dates.length) return fallback
  const counts = new Map<string, number>()
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1)
  let best = dates[0]!
  let bestN = 0
  for (const [d, n] of counts) {
    if (n > bestN) {
      best = d
      bestN = n
    }
  }
  if (bestN >= Math.ceil(dates.length / 2)) return best
  return fallback
}
