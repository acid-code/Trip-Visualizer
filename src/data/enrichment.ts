import type { TripItem } from '../domain/types'
import { lookupAirport } from './airports'
import { nowIso } from './db'
import { MAX_GEOCODE_QUERY_LEN, safeHttpsUrl } from './security'
import { isValidCoord, parseLat, parseLon } from './validate'

function asCoord(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = parseLat(lat as string | number | null)
  const lo = parseLon(lon as string | number | null)
  if (!isValidCoord(la, lo)) return null
  return { lat: la!, lon: lo! }
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse'
const WIKIDATA = 'https://www.wikidata.org/w/api.php'

export type PlaceLookup = {
  lat: number
  lon: number
  /** Short place name when available */
  name: string
  /** Full display / mailing-style address */
  address: string
  city: string
  osmId: string
  query: string
}

type NominatimAddress = {
  tourism?: string
  amenity?: string
  leisure?: string
  shop?: string
  building?: string
  highway?: string
  road?: string
  pedestrian?: string
  neighbourhood?: string
  suburb?: string
  city?: string
  town?: string
  village?: string
  municipality?: string
  county?: string
  state?: string
  postcode?: string
  country?: string
  house_number?: string
}

type NominatimHit = {
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  osm_type?: string
  osm_id?: number | string
  address?: NominatimAddress
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function cityFromAddress(addr?: NominatimAddress): string {
  if (!addr) return ''
  return (
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.suburb ||
    addr.county ||
    ''
  )
}

function nameFromHit(hit: NominatimHit): string {
  const addr = hit.address
  const named =
    hit.name ||
    addr?.tourism ||
    addr?.amenity ||
    addr?.leisure ||
    addr?.shop ||
    addr?.building ||
    ''
  if (named) return named
  if (addr?.road || addr?.pedestrian) {
    const road = addr.road || addr.pedestrian || ''
    return addr.house_number ? `${road} ${addr.house_number}` : road
  }
  const display = hit.display_name || ''
  return display.split(',')[0]?.trim() || ''
}

function addressFromHit(hit: NominatimHit): string {
  return (hit.display_name || '').trim()
}

function osmIdFromHit(hit: NominatimHit): string {
  if (hit.osm_id == null) return ''
  const t = hit.osm_type ? `${hit.osm_type}/` : ''
  return `${t}${hit.osm_id}`
}

function placeFromHit(hit: NominatimHit, query = ''): PlaceLookup | null {
  const coord = asCoord(hit.lat, hit.lon)
  if (!coord) return null
  return {
    lat: coord.lat,
    lon: coord.lon,
    name: nameFromHit(hit),
    address: addressFromHit(hit),
    city: cityFromAddress(hit.address),
    osmId: osmIdFromHit(hit),
    query,
  }
}

export async function geocodePlace(query: string): Promise<{ lat: number; lon: number } | null> {
  const full = await lookupPlace(query)
  return full ? { lat: full.lat, lon: full.lon } : null
}

/** Forward geocode with name / address details (Nominatim). */
export async function lookupPlace(query: string): Promise<PlaceLookup | null> {
  const q = query.trim().slice(0, MAX_GEOCODE_QUERY_LEN)
  if (!q) return null
  const url = new URL(NOMINATIM)
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', '1')
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const data = (await res.json()) as NominatimHit[]
  if (!data[0]) return null
  return placeFromHit(data[0], q)
}

/** Reverse geocode a map pin into name + address. */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<PlaceLookup | null> {
  if (!isValidCoord(lat, lon)) return null
  const url = new URL(NOMINATIM_REVERSE)
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('zoom', '18')
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const hit = (await res.json()) as NominatimHit & { error?: string }
  if (hit.error) return null
  return placeFromHit(hit, `${lat.toFixed(5)},${lon.toFixed(5)}`)
}

/** Pull lat/lon out of a pasted Google Maps link, coords, or leave null to geocode text. */
export function extractCoordsFromText(input: string): { lat: number; lon: number } | null {
  const s = input.trim()
  if (!s) return null

  const at = s.match(/@(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/)
  if (at) return asCoord(at[1], at[2])

  const bang = s.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/)
  if (bang) return asCoord(bang[1], bang[2])

  const qCoords = s.match(
    /[?&](?:q|query)=(-?\d+\.?\d*)(?:%2C|,)\s*(-?\d+\.?\d*)/i,
  )
  if (qCoords) return asCoord(qCoords[1], qCoords[2])

  const plain = s.match(/^(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})$/)
  if (plain) return asCoord(plain[1], plain[2])

  return null
}

/** Turn a Maps URL / address paste into a Nominatim search string when coords aren't embedded. */
export function locationQueryFromInput(input: string): string {
  const s = input.trim()
  if (!s) return ''

  const place = s.match(/\/maps\/place\/([^/@]+)/)
  if (place) {
    try {
      return decodeURIComponent(place[1].replace(/\+/g, ' '))
    } catch {
      return place[1].replace(/\+/g, ' ')
    }
  }

  const q = s.match(/[?&](?:q|query)=([^&]+)/i)
  if (q) {
    try {
      return decodeURIComponent(q[1].replace(/\+/g, ' '))
    } catch {
      return q[1].replace(/\+/g, ' ')
    }
  }

  if (/^https?:\/\//i.test(s)) return ''
  return s
}

/** Resolve a phone paste: Google Maps URL, "lat, lon", or plain address. */
export async function resolveLocationInput(
  input: string,
): Promise<{ lat: number; lon: number; query: string } | null> {
  const coords = extractCoordsFromText(input)
  if (coords) return { ...coords, query: input.trim() }
  const q = locationQueryFromInput(input)
  if (!q) return null
  const g = await geocodePlace(q)
  if (!g) return null
  return { ...g, query: q }
}

/**
 * Fill lat/lon (and latTo/lonTo for legs) from place / from / to text.
 * No Wikidata — used right after Add so pins appear without a full Enrich.
 */
export async function pinItemOnMap(item: TripItem): Promise<TripItem> {
  const next: TripItem = { ...item, updatedAt: nowIso() }
  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(item.type)

  if (isLeg) {
    if (!isValidCoord(next.lat, next.lon)) {
      const airport = lookupAirport(item.from)
      if (airport) {
        next.lat = airport.lat
        next.lon = airport.lon
      } else {
        const g = await resolveLocationInput(item.from || item.place)
        if (g) {
          next.lat = g.lat
          next.lon = g.lon
          next.geocodeQuery = g.query
        }
      }
    }
    if (!isValidCoord(next.latTo, next.lonTo)) {
      const airport = lookupAirport(item.to)
      if (airport) {
        next.latTo = airport.lat
        next.lonTo = airport.lon
      } else {
        const g = await resolveLocationInput(item.to)
        if (g) {
          next.latTo = g.lat
          next.lonTo = g.lon
        }
      }
    }
    return next
  }

  if (item.type === 'note') return next
  if (isValidCoord(next.lat, next.lon)) return next

  const pasted = item.place || item.geocodeQuery
  if (pasted) {
    const g = await resolveLocationInput(pasted)
    if (g) {
      next.lat = g.lat
      next.lon = g.lon
      next.geocodeQuery = g.query
      return next
    }
  }

  const q = [item.place || item.title, item.city].filter(Boolean).join(', ')
  if (!q.trim()) return next
  next.geocodeQuery = q
  const g = await geocodePlace(q)
  if (g) {
    next.lat = g.lat
    next.lon = g.lon
  }
  return next
}

function itemNeedsPinning(item: TripItem): boolean {
  if (item.type === 'note' || item.status === 'cancelled') return false
  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(item.type)
  if (isLeg) {
    const missFrom = !isValidCoord(item.lat, item.lon)
    const missTo = !isValidCoord(item.latTo, item.lonTo)
    if (!missFrom && !missTo) return false
    return !!(item.from || item.to || item.place || item.geocodeQuery)
  }
  if (isValidCoord(item.lat, item.lon)) return false
  return !!(item.place || item.geocodeQuery || item.title || item.city)
}

/**
 * Geocode every step that has an address/from/to but no coordinates.
 * Rate-limited for Nominatim (same as Enrich).
 */
export async function pinTripItemsOnMap(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<TripItem[]> {
  const needIdx = items
    .map((item, i) => (itemNeedsPinning(item) ? i : -1))
    .filter((i) => i >= 0)
  if (!needIdx.length) {
    onProgress?.(items.length, items.length)
    return items
  }

  const out = [...items]
  let done = 0
  for (const i of needIdx) {
    out[i] = await pinItemOnMap(out[i]!)
    done += 1
    onProgress?.(done, needIdx.length)
    // Nominatim usage policy ~1 req/s
    if (done < needIdx.length) await sleep(1100)
  }
  return out
}

export async function fetchWikidataSummary(idOrTitle: string): Promise<{
  id: string
  summary: string
  image?: string
} | null> {
  const isId = /^Q\d+$/i.test(idOrTitle)
  const url = new URL(WIKIDATA)
  url.searchParams.set('action', 'wbgetentities')
  url.searchParams.set('format', 'json')
  url.searchParams.set('origin', '*')
  url.searchParams.set('props', 'labels|descriptions|claims')
  url.searchParams.set('languages', 'en')
  if (isId) {
    url.searchParams.set('ids', idOrTitle.toUpperCase())
  } else {
    url.searchParams.set('sites', 'enwiki')
    url.searchParams.set('titles', idOrTitle)
  }
  const res = await fetch(url.toString())
  if (!res.ok) return null
  const json = (await res.json()) as {
    entities?: Record<
      string,
      {
        id: string
        labels?: { en?: { value: string } }
        descriptions?: { en?: { value: string } }
        claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> }
      }
    >
  }
  const entity = Object.values(json.entities ?? {}).find((e) => e.id)
  if (!entity) return null
  const file = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value
  let image: string | undefined
  if (file) {
    image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=640`
  }
  return {
    id: entity.id,
    summary: entity.descriptions?.en?.value || entity.labels?.en?.value || '',
    image,
  }
}

export async function fetchDrivingRoute(
  from: [number, number],
  to: [number, number],
): Promise<[number, number][]> {
  const { fetchOsrmRoute } = await import('./routes')
  return fetchOsrmRoute(from, to, 'driving')
}

function resolveEndpoint(codeOrPlace: string): { lat: number; lon: number } | null {
  const airport = lookupAirport(codeOrPlace)
  if (airport) return { lat: airport.lat, lon: airport.lon }
  return null
}

export async function enrichItem(item: TripItem): Promise<TripItem> {
  const next: TripItem = {
    ...item,
    updatedAt: nowIso(),
    source: item.source === 'example' ? 'example' : 'enriched',
  }

  if (item.type === 'flight' || item.type === 'train' || item.type === 'bus' || item.type === 'ferry') {
    const from =
      resolveEndpoint(item.from) ||
      (isValidCoord(item.lat, item.lon) ? { lat: item.lat!, lon: item.lon! } : null)
    const to =
      resolveEndpoint(item.to) ||
      (isValidCoord(item.latTo, item.lonTo)
        ? { lat: item.latTo!, lon: item.lonTo! }
        : null)

    if (!from && item.from) {
      const g = await geocodePlace(item.from)
      await sleep(1100)
      if (g) {
        next.lat = g.lat
        next.lon = g.lon
        next.geocodeQuery = item.from
      }
    } else if (from) {
      next.lat = from.lat
      next.lon = from.lon
    }

    if (!to && item.to) {
      const g = await geocodePlace(item.to)
      await sleep(1100)
      if (g) {
        next.latTo = g.lat
        next.lonTo = g.lon
      }
    } else if (to) {
      next.latTo = to.lat
      next.lonTo = to.lon
    }
  } else if (item.type === 'drive') {
    let from: { lat: number; lon: number } | null = isValidCoord(item.lat, item.lon)
      ? { lat: item.lat!, lon: item.lon! }
      : resolveEndpoint(item.from)
    let to: { lat: number; lon: number } | null = isValidCoord(item.latTo, item.lonTo)
      ? { lat: item.latTo!, lon: item.lonTo! }
      : resolveEndpoint(item.to)

    if (!from && (item.from || item.place)) {
      from = await geocodePlace(item.from || item.place)
      await sleep(1100)
    }
    if (!to && item.to) {
      to = await geocodePlace(item.to)
      await sleep(1100)
    }
    if (from) {
      next.lat = from.lat
      next.lon = from.lon
    }
    if (to) {
      next.latTo = to.lat
      next.lonTo = to.lon
    }
    if (from && to) {
      try {
        next.routeCoords = await fetchDrivingRoute(
          [from.lat, from.lon],
          [to.lat, to.lon],
        )
      } catch {
        next.routeCoords = [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ]
      }
    }
  } else if (item.type !== 'note') {
    if (!isValidCoord(item.lat, item.lon)) {
      const q = [item.place || item.title, item.city].filter(Boolean).join(', ')
      next.geocodeQuery = q
      const g = await geocodePlace(q)
      await sleep(1100)
      if (g) {
        next.lat = g.lat
        next.lon = g.lon
      }
    }
  }

  const wikiKey = item.wikidata || item.place || item.title
  if (wikiKey && item.type !== 'note' && item.type !== 'drive' && item.type !== 'flight') {
    try {
      const wiki = await fetchWikidataSummary(wikiKey)
      if (wiki) {
        next.wikidata = wiki.id
        next.enrichmentSummary = wiki.summary
        next.enrichmentImage = safeHttpsUrl(wiki.image || '')
        next.enrichmentSource = 'Wikidata'
      }
    } catch {
      // ignore enrichment failures
    }
  }

  return next
}

export async function enrichTripItems(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<TripItem[]> {
  const out: TripItem[] = []
  for (let i = 0; i < items.length; i++) {
    out.push(await enrichItem(items[i]))
    onProgress?.(i + 1, items.length)
  }
  return out
}
