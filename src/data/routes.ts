import type { TripItem } from '../domain/types'
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
 * Walking connectors between consecutive same-day steps (by time order).
 * Skips pairs that are already an explicit drive/flight/train leg.
 */
export async function buildWalkingConnectors(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<RouteConnector[]> {
  const sorted = sortItems(
    items.filter((i) => i.status !== 'cancelled' && i.type !== 'note'),
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

  for (const [date, dayItems] of byDate) {
    for (let i = 0; i < dayItems.length - 1; i++) {
      const from = dayItems[i]
      const to = dayItems[i + 1]

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
        if (distKm(a, b) < 0.05 || distKm(a, b) > 12) continue
        pairs.push({ id: `walk:${from.id}->${to.id}`, date, from, to, a, b })
        continue
      }

      if (!POINTISH.has(from.type) || !POINTISH.has(to.type)) continue
      const a = pointOf(from)
      const b = pointOf(to)
      if (!a || !b) continue
      const d = distKm(a, b)
      if (d < 0.05 || d > 8) continue
      pairs.push({ id: `walk:${from.id}->${to.id}`, date, from, to, a, b })
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

function distKm(
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
