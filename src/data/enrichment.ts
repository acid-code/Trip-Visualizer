import type { PlanPlace, TripItem } from '../domain/types'
import { lookupAirport } from './airports'
import { nowIso } from './db'
import { fetchGoogleTextViaProxy } from './placesGoogle'
import { fetchOsrmRoute } from './routes'
import { MAX_GEOCODE_QUERY_LEN, safeHttpsUrl } from './security'
import { isValidCoord, parseLat, parseLon } from './validate'

function asCoord(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = parseLat(lat as string | number | null)
  const lo = parseLon(lon as string | number | null)
  if (!isValidCoord(la, lo)) return null
  return { lat: la!, lon: lo! }
}

const NOMINATIM_PROXY = '/api/nominatim'
/** Identify this app — sent from the Node proxy (browsers cannot set User-Agent). */
const NOMINATIM_UA = 'trip-worker/0.1 (trip planner; local geocode)'
const WIKIDATA = 'https://www.wikidata.org/w/api.php'

let lastNominatimAt = 0

async function nominatimRateLimit() {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimAt))
  if (wait) await sleep(wait)
  lastNominatimAt = Date.now()
}

function nominatimHeaders(): HeadersInit {
  return {
    Accept: 'application/json',
    // Hint for proxies; real UA is set server-side on /api/nominatim
    'X-Trip-Worker-Client': NOMINATIM_UA,
  }
}

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

const geocodeCache = new Map<string, PlaceLookup | null>()
const GEOCODE_CACHE_MAX = 80

function cacheGet(key: string): PlaceLookup | null | undefined {
  if (!geocodeCache.has(key)) return undefined
  return geocodeCache.get(key) ?? null
}

function cacheSet(key: string, value: PlaceLookup | null) {
  geocodeCache.set(key, value)
  if (geocodeCache.size > GEOCODE_CACHE_MAX) {
    const first = geocodeCache.keys().next().value
    if (first !== undefined) geocodeCache.delete(first)
  }
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

/** Forward geocode with name / address details.
 *  Nominatim first (free). Google Text Search only as fallback when allowed —
 *  Text Search was the Atmosphere SKU that drove billing.
 */
export async function lookupPlace(
  query: string,
  opts?: {
    /**
     * If true and Nominatim misses, try Google Text Search once.
     * Prefer leaving this false for bulk geocode / enrich paths.
     */
    useGooglePlaces?: boolean
    /** Data-panel override only. */
    googleApiKey?: string
    bias?: { lat: number; lon: number; radiusM?: number }
    /**
     * Skip Nominatim and hit Google Text first (rare — e.g. stubborn Maps place names).
     * Default false.
     */
    preferGoogleText?: boolean
  },
): Promise<PlaceLookup | null> {
  const qRaw = query.trim().slice(0, MAX_GEOCODE_QUERY_LEN)
  if (!qRaw) return null

  // Fast path: known IATA / airport labels
  const airport = lookupAirport(qRaw)
  if (airport) {
    return {
      lat: airport.lat,
      lon: airport.lon,
      name: airport.name,
      address: `${airport.name}, ${airport.city}`,
      city: airport.city,
      osmId: '',
      query: qRaw,
    }
  }

  const cacheKey = [
    qRaw.toLowerCase(),
    opts?.bias
      ? `${opts.bias.lat.toFixed(2)},${opts.bias.lon.toFixed(2)}`
      : '',
    opts?.useGooglePlaces ? 'g' : '',
  ].join('|')
  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  const googleKey = opts?.googleApiKey?.trim()
  const googleAllowed = Boolean(opts?.useGooglePlaces || googleKey)

  async function tryGoogle(q: string): Promise<PlaceLookup | null> {
    if (!googleAllowed) return null
    try {
      const hit = await fetchGoogleTextViaProxy({
        query: q,
        apiKey: googleKey || undefined,
        bias: opts?.bias,
      })
      if (!hit) return null
      return {
        lat: hit.lat,
        lon: hit.lon,
        name: hit.name,
        address: hit.address || hit.name,
        city: '',
        osmId: hit.placeId ? `google:${hit.placeId}` : '',
        query: q,
      }
    } catch {
      return null
    }
  }

  async function nominatimSearch(
    q: string,
    withBias: boolean,
  ): Promise<PlaceLookup | null> {
    const params = new URLSearchParams()
    params.set('q', q)
    params.set('limit', '3')
    if (
      withBias &&
      opts?.bias &&
      isValidCoord(opts.bias.lat, opts.bias.lon)
    ) {
      const d = Math.min(
        Math.max((opts.bias.radiusM ?? 80_000) / 111_000, 0.08),
        2,
      )
      params.set(
        'viewbox',
        `${opts.bias.lon - d},${opts.bias.lat + d},${opts.bias.lon + d},${opts.bias.lat - d}`,
      )
    }
    await nominatimRateLimit()
    const res = await fetch(`${NOMINATIM_PROXY}?${params.toString()}`, {
      headers: nominatimHeaders(),
    })
    if (!res.ok) return null
    const data = (await res.json()) as NominatimHit[] | { error?: string }
    if (!Array.isArray(data) || !data[0]) return null
    return placeFromHit(data[0], q)
  }

  async function tryNominatimVariants(): Promise<PlaceLookup | null> {
    const variants = geocodeQueryVariants(qRaw)
    // First pass: with soft viewbox bias when available
    for (const v of variants) {
      const hit = await nominatimSearch(v, true)
      if (hit) return hit
    }
    // Second pass: no viewbox (bias sometimes excludes the right hit)
    if (opts?.bias) {
      for (const v of variants.slice(0, 3)) {
        const hit = await nominatimSearch(v, false)
        if (hit) return hit
      }
    }
    return null
  }

  let result: PlaceLookup | null = null
  if (opts?.preferGoogleText) {
    result =
      (await tryGoogle(normalizeGeocodeQuery(qRaw) || qRaw)) ||
      (await tryNominatimVariants())
  } else {
    result = (await tryNominatimVariants()) || (await tryGoogle(normalizeGeocodeQuery(qRaw) || qRaw))
  }
  cacheSet(cacheKey, result)
  return result
}

/** Reverse geocode a map pin into name + address. */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<PlaceLookup | null> {
  if (!isValidCoord(lat, lon)) return null
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    zoom: '18',
  })
  await nominatimRateLimit()
  const res = await fetch(`${NOMINATIM_PROXY}?${params.toString()}`, {
    headers: nominatimHeaders(),
  })
  if (!res.ok) return null
  const hit = (await res.json()) as NominatimHit & { error?: string }
  if (hit.error || !hit.lat) return null
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

/** Soften vague labels so geocoders hit a real place. */
export function normalizeGeocodeQuery(input: string): string {
  let s = input.trim()
  if (!s) return ''
  // AI day-base titles: "Avignon base", "Nice stay-zone"
  s = s
    .replace(/\s+(base|stay-?zone|area)\s*$/i, '')
    .replace(/\s+base\b/gi, '')
    .trim()
  if (/^paris\s*(center|centre|city\s*center|city\s*centre)?$/i.test(s)) {
    return 'Paris, France'
  }
  if (/^mrs(\s+airport)?$/i.test(s)) return 'Marseille Provence Airport, France'
  if (/^cdg(\s+airport)?$/i.test(s)) return 'Charles de Gaulle Airport, Paris, France'
  if (/^ory(\s+airport)?$/i.test(s)) return 'Orly Airport, Paris, France'
  if (/^lhr(\s+airport)?$/i.test(s)) return 'Heathrow Airport, London, UK'
  if (/^nce(\s+airport)?$/i.test(s)) return 'Nice Côte d’Azur Airport, France'
  if (/^tlv(\s+airport)?$/i.test(s)) return 'Ben Gurion Airport, Tel Aviv, Israel'
  if (/^jfk(\s+airport)?$/i.test(s)) return 'John F Kennedy Airport, New York, USA'
  return s
}

/** Ordered query variants to retry when Nominatim returns []. */
export function geocodeQueryVariants(input: string): string[] {
  const primary = normalizeGeocodeQuery(input)
  if (!primary) return []
  const out: string[] = []
  const push = (q: string) => {
    const t = q.trim()
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  push(primary)
  // Drop parenthetical noise
  push(primary.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
  // City before comma only
  const beforeComma = primary.split(',')[0]?.trim()
  if (beforeComma && beforeComma.length >= 2) push(beforeComma)
  // Common European trip context when query is a bare city/region
  if (beforeComma && !/,/.test(primary) && beforeComma.split(/\s+/).length <= 3) {
    push(`${beforeComma}, France`)
    push(`${beforeComma}, Italy`)
    push(`${beforeComma}, Spain`)
    push(`${beforeComma}, UK`)
  }
  return out.slice(0, 6)
}

function normalizeMatchKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Prefer an already-pinned hotel when From/To is just a city / hotel label. */
function coordFromRelatedHotels(
  label: string,
  hotels: TripItem[] | undefined,
): { lat: number; lon: number } | null {
  if (!hotels?.length) return null
  const q = normalizeMatchKey(label)
  if (!q || q.length < 2) return null

  let best: { lat: number; lon: number; score: number } | null = null
  for (const h of hotels) {
    if (!isValidCoord(h.lat, h.lon)) continue
    const candidates = [h.city, h.place, h.title]
      .map(normalizeMatchKey)
      .filter((c) => c.length >= 2)
    for (const c of candidates) {
      let score = 0
      if (q === c) score = 100
      else if (q.includes(c) || c.includes(q)) score = Math.min(q.length, c.length)
      if (score > 0 && (!best || score > best.score)) {
        best = { lat: h.lat!, lon: h.lon!, score }
      }
    }
  }
  return best ? { lat: best.lat, lon: best.lon } : null
}

export type PinMapOpts = {
  useGooglePlaces?: boolean
  googleApiKey?: string
  /** Hotels (or other pinned stays) used as From/To fallbacks for drives. */
  hotels?: TripItem[]
}

/** Resolve a phone paste: Google Maps URL, "lat, lon", or plain address. */
export async function resolveLocationInput(
  input: string,
  opts?: PinMapOpts,
): Promise<{ lat: number; lon: number; query: string } | null> {
  const coords = extractCoordsFromText(input)
  if (coords) return { ...coords, query: input.trim() }
  const raw = locationQueryFromInput(input)
  if (!raw) return null
  const q = normalizeGeocodeQuery(raw)
  const g = await lookupPlace(q, {
    useGooglePlaces: opts?.useGooglePlaces,
    googleApiKey: opts?.googleApiKey,
  })
  if (!g) return null
  return { lat: g.lat, lon: g.lon, query: q }
}

async function resolveLegEndpoint(
  label: string,
  opts?: PinMapOpts,
): Promise<{ lat: number; lon: number; query?: string } | null> {
  const text = label.trim()
  if (!text) return null
  const airport = lookupAirport(text)
  if (airport) return { lat: airport.lat, lon: airport.lon, query: text }
  const hotel = coordFromRelatedHotels(text, opts?.hotels)
  if (hotel) return { ...hotel, query: text }
  return resolveLocationInput(text, opts)
}

/**
 * Fill lat/lon (and latTo/lonTo for legs) from place / from / to text.
 * No Wikidata — used right after Add so pins appear without a full Enrich.
 */
export async function pinItemOnMap(
  item: TripItem,
  opts?: PinMapOpts,
): Promise<TripItem> {
  const next: TripItem = { ...item, updatedAt: nowIso() }
  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(item.type)

  if (isLeg) {
    if (!isValidCoord(next.lat, next.lon)) {
      const from = await resolveLegEndpoint(item.from || item.place, opts)
      if (from) {
        next.lat = from.lat
        next.lon = from.lon
        if (from.query) next.geocodeQuery = from.query
      }
    }
    if (!isValidCoord(next.latTo, next.lonTo)) {
      const to = await resolveLegEndpoint(item.to, opts)
      if (to) {
        next.latTo = to.lat
        next.lonTo = to.lon
      }
    }
    return next
  }

  if (item.type === 'note') return next
  if (isValidCoord(next.lat, next.lon)) return next

  const pasted = item.place || item.geocodeQuery
  if (pasted) {
    const g = await resolveLocationInput(pasted, opts)
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
  const g = await lookupPlace(normalizeGeocodeQuery(q), {
    useGooglePlaces: opts?.useGooglePlaces,
    googleApiKey: opts?.googleApiKey,
  })
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
  opts?: PinMapOpts,
): Promise<TripItem[]> {
  const needIdx = items
    .map((item, i) => (itemNeedsPinning(item) ? i : -1))
    .filter((i) => i >= 0)
  if (!needIdx.length) {
    onProgress?.(items.length, items.length)
    return items
  }

  const out = [...items]
  // Prefer already-known hotel pins (and ones we fill as we go) for drive From/To.
  const hotels = () =>
    out.filter((i) => i.type === 'hotel' && isValidCoord(i.lat, i.lon))

  let done = 0
  for (const i of needIdx) {
    out[i] = await pinItemOnMap(out[i]!, {
      ...opts,
      hotels: [...(opts?.hotels ?? []), ...hotels()],
    })
    done += 1
    onProgress?.(done, needIdx.length)
    // Extra pause when falling back to Nominatim (Google is already paced by proxy)
    if (!opts?.useGooglePlaces && done < needIdx.length) await sleep(200)
  }
  return out
}

/**
 * Geocode Plan list pins missing coordinates (Excel restore without Lat/Lon).
 * Cap work so large boards don't stall import.
 */
export async function pinPlanPlacesOnMap(
  places: PlanPlace[],
  onProgress?: (done: number, total: number) => void,
  opts?: { max?: number },
): Promise<PlanPlace[]> {
  const max = opts?.max ?? 60
  const needIdx = places
    .map((p, i) => {
      if (isValidCoord(p.lat, p.lon)) return -1
      const q = [p.place, p.name, p.city].filter(Boolean).join(', ').trim()
      return q ? i : -1
    })
    .filter((i) => i >= 0)
    .slice(0, max)

  if (!needIdx.length) {
    onProgress?.(places.length, places.length)
    return places
  }

  const out = [...places]
  let done = 0
  for (const i of needIdx) {
    const p = out[i]!
    const q = [p.place, p.name, p.city].filter(Boolean).join(', ')
    const hit = await lookupPlace(q)
    if (hit && isValidCoord(hit.lat, hit.lon)) {
      out[i] = {
        ...p,
        lat: hit.lat,
        lon: hit.lon,
        place: p.place || hit.address || p.place,
        city: p.city || hit.city || p.city,
        osmId: p.osmId || hit.osmId || '',
      }
    }
    done += 1
    onProgress?.(done, needIdx.length)
    if (done < needIdx.length) await sleep(200)
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

/** True when an item still needs geocode / route fill (background Enrich). */
export function itemNeedsEnrich(item: TripItem): boolean {
  if (item.type === 'note') return false
  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(item.type)
  if (isLeg) {
    if (!isValidCoord(item.lat, item.lon) && (item.from || item.place)) return true
    if (item.to && !isValidCoord(item.latTo, item.lonTo)) return true
    if (
      item.type === 'drive' &&
      isValidCoord(item.lat, item.lon) &&
      isValidCoord(item.latTo, item.lonTo)
    ) {
      return !(item.routeCoords && item.routeCoords.length >= 2)
    }
    return false
  }
  return !isValidCoord(item.lat, item.lon) && Boolean(item.place || item.title)
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

/** Enrich only items that still need pins / summaries. */
export async function enrichNeedyTripItems(
  items: TripItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<TripItem[]> {
  const needyIdx: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (itemNeedsEnrich(items[i]!)) needyIdx.push(i)
  }
  if (!needyIdx.length) return items
  const out = items.slice()
  for (let n = 0; n < needyIdx.length; n++) {
    const i = needyIdx[n]!
    out[i] = await enrichItem(out[i]!)
    onProgress?.(n + 1, needyIdx.length)
  }
  return out
}
