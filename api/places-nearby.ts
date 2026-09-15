/**
 * Proxy for Places API (New) Nearby Search — avoids browser CORS.
 * Fully self-contained: Vercel does not bundle ../src into /api functions.
 */

export const config = {
  maxDuration: 30,
}

const GOOGLE_NEARBY_MAX = 20
const PLACES_NEARBY = 'https://places.googleapis.com/v1/places:searchNearby'

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.regularOpeningHours',
].join(',')

const INCLUDED_TYPES_ALL = [
  'restaurant',
  'cafe',
  'bakery',
  'bar',
  'winery',
  'museum',
  'art_gallery',
  'tourist_attraction',
  'park',
  'historical_landmark',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
  'zoo',
  'amusement_park',
  'aquarium',
  'beach',
  'marina',
  'lodging',
]

const INCLUDED_TYPES_BY_CATEGORY: Record<string, string[]> = {
  food: ['restaurant', 'cafe', 'bakery'],
  drink: ['bar', 'winery', 'night_club', 'pub'],
  sights: [
    'museum',
    'art_gallery',
    'tourist_attraction',
    'historical_landmark',
    'church',
    'hindu_temple',
    'mosque',
    'synagogue',
    'zoo',
    'amusement_park',
    'aquarium',
    'performing_arts_theater',
    'visitor_center',
  ],
  hotel: ['lodging'],
  nature: ['park', 'beach', 'marina', 'campground', 'national_park'],
  other: INCLUDED_TYPES_ALL,
}

function includedTypesForCategories(
  raw: unknown,
  unrestricted?: boolean,
): string[] | null {
  if (unrestricted) return null
  if (!Array.isArray(raw) || !raw.length) return INCLUDED_TYPES_ALL
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const cat = String(item || '').toLowerCase()
    for (const t of INCLUDED_TYPES_BY_CATEGORY[cat] ?? []) {
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out.length ? out : INCLUDED_TYPES_ALL
}

type VercelReq = {
  method?: string
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
}

type VercelRes = {
  status: (code: number) => VercelRes
  setHeader: (name: string, value: string) => void
  json: (body: unknown) => void
  send: (body: string) => void
}

type GooglePlace = {
  id?: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  types?: string[]
  primaryType?: string
  formattedAddress?: string
  rating?: number
  userRatingCount?: number
  photos?: Array<{ name?: string }>
  websiteUri?: string
  googleMapsUri?: string
  regularOpeningHours?: {
    weekdayDescriptions?: string[]
    periods?: Array<{
      open?: { day?: number; hour?: number; minute?: number }
      close?: { day?: number; hour?: number; minute?: number }
    }>
  }
}

function header(req: VercelReq, name: string): string {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0] || ''
  return typeof raw === 'string' ? raw : ''
}

function originAllowed(req: VercelReq): boolean {
  const origin = header(req, 'origin') || header(req, 'referer')
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app') ||
      host === 'trip-visualizer-eta.vercel.app'
    )
  } catch {
    return false
  }
}

function resolveApiKey(bodyKey?: unknown): string {
  const fromBody = String(bodyKey ?? '').trim()
  if (fromBody.startsWith('AIza')) return fromBody
  return String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim()
}

function clamp(s: string, n: number): string {
  return s.trim().slice(0, n)
}

function httpsUrl(raw: string): string {
  const s = raw.trim()
  if (!s.startsWith('https://')) return ''
  try {
    return new URL(s).toString()
  } catch {
    return ''
  }
}

function distKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function categoryFromTypes(primary: string, types: string[]): string {
  const p = (primary || '').toLowerCase()
  const all = [p, ...types.map((t) => t.toLowerCase())].filter(Boolean)
  const has = (t: string) => all.includes(t)

  const isLodgingType = (t: string) =>
    t === 'lodging' ||
    t === 'hotel' ||
    t === 'motel' ||
    t === 'resort_hotel' ||
    t === 'extended_stay_hotel' ||
    t === 'guest_house' ||
    t === 'hostel'

  const isFoodType = (t: string) =>
    t === 'restaurant' ||
    t === 'cafe' ||
    t === 'bakery' ||
    t === 'meal_takeaway' ||
    t === 'meal_delivery' ||
    t === 'food'

  const isDrinkType = (t: string) =>
    t === 'bar' || t === 'night_club' || t === 'pub' || t === 'winery'

  if (p && isFoodType(p)) return 'food'
  if (p && isDrinkType(p)) return 'drink'
  if (p && isLodgingType(p)) return 'hotel'

  if (all.some(isFoodType) && all.some(isLodgingType)) return 'food'
  if (all.some(isDrinkType) && all.some(isLodgingType)) return 'drink'
  if (all.some(isLodgingType)) return 'hotel'
  if (all.some(isFoodType)) return 'food'
  if (all.some(isDrinkType)) return 'drink'
  if (has('vineyard')) return 'drink'
  if (has('park') || has('campground') || has('national_park') || has('natural_feature') || has('beach') || has('marina')) {
    return 'nature'
  }
  if (
    has('museum') ||
    has('art_gallery') ||
    has('tourist_attraction') ||
    has('historical_landmark') ||
    has('church') ||
    has('hindu_temple') ||
    has('mosque') ||
    has('synagogue') ||
    has('zoo') ||
    has('aquarium') ||
    has('amusement_park') ||
    has('performing_arts_theater') ||
    has('visitor_center')
  ) {
    return 'sights'
  }
  return 'other'
}

function parseGoogleHours(raw: GooglePlace['regularOpeningHours']): {
  openingHours: string
  openingPeriods?: Array<{
    open: { day: number; hour: number; minute: number }
    close?: { day: number; hour: number; minute: number }
  }>
} {
  if (!raw) return { openingHours: '' }
  const openingHours = (raw.weekdayDescriptions || [])
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .join('; ')
    .slice(0, 400)
  const openingPeriods = []
  for (const row of raw.periods || []) {
    const o = row.open
    if (!o || o.day == null || o.hour == null) continue
    const day = Number(o.day)
    const hour = Number(o.hour)
    const minute = Number(o.minute ?? 0)
    if (day < 0 || day > 6 || hour < 0 || hour > 23) continue
    const period: {
      open: { day: number; hour: number; minute: number }
      close?: { day: number; hour: number; minute: number }
    } = {
      open: { day, hour, minute: Number.isFinite(minute) ? minute : 0 },
    }
    const c = row.close
    if (c && c.day != null && c.hour != null) {
      const cd = Number(c.day)
      const ch = Number(c.hour)
      const cm = Number(c.minute ?? 0)
      if (cd >= 0 && cd <= 6 && ch >= 0 && ch <= 23) {
        period.close = {
          day: cd,
          hour: ch,
          minute: Number.isFinite(cm) ? cm : 0,
        }
      }
    }
    openingPeriods.push(period)
  }
  return {
    openingHours:
      openingHours || (openingPeriods.length ? 'Hours on file' : ''),
    openingPeriods: openingPeriods.length ? openingPeriods : undefined,
  }
}

function toPlace(gp: GooglePlace, anchor: { lat: number; lon: number }) {
  const lat = gp.location?.latitude
  const lon = gp.location?.longitude
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const name = clamp(gp.displayName?.text || '', 120)
  if (!name) return null
  const placeId = clamp(gp.id || '', 128)
  if (!placeId) return null
  const types = gp.types || []
  const primary = gp.primaryType || types[0] || ''
  const photoName = gp.photos?.[0]?.name || ''
  const mapsUri = httpsUrl(gp.googleMapsUri || '')
  const rating =
    typeof gp.rating === 'number' && Number.isFinite(gp.rating)
      ? Math.round(gp.rating * 10) / 10
      : null
  const hours = parseGoogleHours(gp.regularOpeningHours)

  return {
    id: `google:${placeId}`,
    name,
    lat: lat!,
    lon: lon!,
    category: categoryFromTypes(primary, types),
    osmType: 'google',
    osmId: placeId,
    wikidata: '',
    images: [] as string[],
    summary:
      typeof gp.userRatingCount === 'number' && gp.userRatingCount > 0
        ? clamp(`${gp.userRatingCount} Google reviews`, 80)
        : '',
    distKm: distKm(anchor, { lat: lat!, lon: lon! }),
    rating,
    cuisine: '',
    website: httpsUrl(gp.websiteUri || ''),
    menuUrl: '',
    openingHours: hours.openingHours,
    openingPeriods: hours.openingPeriods,
    address: clamp(gp.formattedAddress || '', 200),
    tags: {
      source: 'google',
      primaryType: primary,
      ...(photoName ? { googlePhotoName: photoName } : {}),
      ...(mapsUri ? { googleMapsUri: mapsUri } : {}),
    },
  }
}

export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  if (!originAllowed(req)) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >
  const lat = Number(body.lat)
  const lon = Number(body.lon)
  const radiusM = Number(body.radiusM) || 1500
  const maxResultCount = Math.min(
    Number(body.maxResultCount) || GOOGLE_NEARBY_MAX,
    GOOGLE_NEARBY_MAX,
  )
  const includedTypes = includedTypesForCategories(
    body.categories,
    Boolean(body.unrestricted),
  )
  const rankPreference =
    String(body.rankPreference || '').toUpperCase() === 'POPULARITY'
      ? 'POPULARITY'
      : 'DISTANCE'
  const apiKey = resolveApiKey(body.apiKey)

  if (!apiKey || !apiKey.startsWith('AIza')) {
    res.status(400).json({ error: 'Google Maps API key required' })
    return
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Invalid coordinates' })
    return
  }

  try {
    const radius = Math.min(Math.max(radiusM, 50), 50000)
    const upstream = await fetch(PLACES_NEARBY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        languageCode: 'en',
        ...(includedTypes ? { includedTypes } : {}),
        maxResultCount,
        rankPreference,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lon },
            radius,
          },
        },
      }),
    })

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.status(502).json({
        error: `Places Nearby ${upstream.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      })
      return
    }

    const json = (await upstream.json()) as { places?: GooglePlace[] }
    const anchor = { lat, lon }
    const seen = new Set<string>()
    const places = []
    for (const gp of json.places ?? []) {
      const place = toPlace(gp, anchor)
      if (!place || seen.has(place.id)) continue
      seen.add(place.id)
      places.push(place)
    }
    places.sort((a, b) => a.distKm - b.distKm)
    res.status(200).json({ places })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Places Nearby failed'
    res.status(502).json({ error: msg })
  }
}
