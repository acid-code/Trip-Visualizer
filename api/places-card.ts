/**
 * Place card details without Text Search Enterprise + Atmosphere.
 *
 * 1. Text Search with field mask `places.id` only (unlimited, $0) to resolve a
 *    Google place id. Skipped when the client already has one.
 * 2. Place Details for that id. Rating, hours, and website select Place Details
 *    Enterprise ($20/1k, 1,000 free/month). editorialSummary / generativeSummary
 *    are intentionally absent — those were the Atmosphere SKU on the bill.
 *
 * Both calls run here so Google sees the server IP, same as LocationIQ.
 */

export const config = {
  maxDuration: 20,
}

const PLACES_TEXT = 'https://places.googleapis.com/v1/places:searchText'
const PLACES_DETAILS = 'https://places.googleapis.com/v1/places'

/** Must stay exactly this. Any other field upgrades Text Search off the free SKU. */
export const TEXT_ID_FIELD_MASK = 'places.id'

/**
 * Highest SKU in this mask is Place Details Enterprise (rating, hours, website).
 * Do not add editorialSummary, generativeSummary, reviews, or amenity flags.
 */
export const PLACE_DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'types',
  'primaryType',
  'googleMapsUri',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'websiteUri',
  'photos',
].join(',')

const ATMOSPHERE_FIELDS = [
  'editorialSummary',
  'generativeSummary',
  'reviews',
  'reviewSummary',
  'allowsDogs',
  'servesBeer',
]

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
  formattedAddress?: string
  location?: { latitude?: number; longitude?: number }
  types?: string[]
  primaryType?: string
  rating?: number
  userRatingCount?: number
  websiteUri?: string
  googleMapsUri?: string
  photos?: Array<{ name?: string }>
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

function httpsUrl(raw: string): string {
  const s = raw.trim()
  if (!s.startsWith('https://')) return ''
  try {
    return new URL(s).toString()
  } catch {
    return ''
  }
}

function categoryFromTypes(primary: string, types: string[]): string {
  const all = [primary, ...types].map((t) => t.toLowerCase()).filter(Boolean)
  const has = (t: string) => all.includes(t)
  const food = ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery', 'food']
  const drink = ['bar', 'night_club', 'pub', 'winery']
  const lodging = [
    'lodging',
    'hotel',
    'motel',
    'resort_hotel',
    'extended_stay_hotel',
    'guest_house',
    'hostel',
  ]
  if (food.some((t) => has(t)) && !lodging.includes(primary.toLowerCase())) return 'food'
  if (drink.some((t) => has(t))) return 'drink'
  if (lodging.some((t) => has(t))) return 'hotel'
  if (
    has('park') ||
    has('campground') ||
    has('national_park') ||
    has('beach') ||
    has('marina')
  ) {
    return 'nature'
  }
  if (
    has('museum') ||
    has('art_gallery') ||
    has('tourist_attraction') ||
    has('historical_landmark') ||
    has('church') ||
    has('mosque') ||
    has('synagogue') ||
    has('zoo') ||
    has('aquarium') ||
    has('amusement_park')
  ) {
    return 'sights'
  }
  return 'other'
}

function placeIdFromRaw(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return s.replace(/^places\//, '').slice(0, 256)
}

export function placeDetailsMaskIsSafe(mask: string): boolean {
  const fields = mask.split(',').map((f) => f.trim()).filter(Boolean)
  return fields.length > 0 && fields.every((f) => !ATMOSPHERE_FIELDS.includes(f))
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
  if (!placeDetailsMaskIsSafe(PLACE_DETAILS_FIELD_MASK) || TEXT_ID_FIELD_MASK !== 'places.id') {
    res.status(500).json({ error: 'Place card field mask is not safe to bill' })
    return
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >
  const apiKey = resolveApiKey(body.apiKey)
  if (!apiKey.startsWith('AIza')) {
    res.status(200).json({ place: null, configured: false })
    return
  }

  const query = String(body.query || '').trim().slice(0, 200)
  let placeId = placeIdFromRaw(String(body.placeId || ''))
  const latIn = Number(body.lat)
  const lonIn = Number(body.lon)
  const hasBias = Number.isFinite(latIn) && Number.isFinite(lonIn)

  if (!placeId && !query) {
    res.status(400).json({ error: 'Missing query' })
    return
  }

  try {
    if (!placeId) {
      const payload: Record<string, unknown> = {
        textQuery: query,
        languageCode: 'en',
        pageSize: 1,
        maxResultCount: 1,
      }
      if (hasBias) {
        payload.locationBias = {
          circle: {
            center: { latitude: latIn, longitude: lonIn },
            radius: 2500,
          },
        }
      }
      const idRes = await fetch(PLACES_TEXT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': TEXT_ID_FIELD_MASK,
        },
        body: JSON.stringify(payload),
      })
      if (!idRes.ok) {
        const text = await idRes.text().catch(() => '')
        res.status(502).json({
          error: `Place id search ${idRes.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
        })
        return
      }
      const idJson = (await idRes.json()) as { places?: Array<{ id?: string }> }
      placeId = placeIdFromRaw(idJson.places?.[0]?.id || '')
      if (!placeId) {
        res.status(200).json({ place: null })
        return
      }
    }

    const detailsRes = await fetch(
      `${PLACES_DETAILS}/${encodeURIComponent(placeId)}?languageCode=en`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
        },
      },
    )
    if (!detailsRes.ok) {
      const text = await detailsRes.text().catch(() => '')
      res.status(502).json({
        error: `Place Details ${detailsRes.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      })
      return
    }
    const gp = (await detailsRes.json()) as GooglePlace
    const name = String(gp.displayName?.text || '').trim().slice(0, 160)
    const lat = gp.location?.latitude
    const lon = gp.location?.longitude
    const types = gp.types || []
    const primary = gp.primaryType || types[0] || ''
    const openingHours = (gp.regularOpeningHours?.weekdayDescriptions || [])
      .map((d) => String(d || '').trim())
      .filter(Boolean)
      .join('; ')
      .slice(0, 800)
    const openingPeriods: Array<{
      open: { day: number; hour: number; minute: number }
      close?: { day: number; hour: number; minute: number }
    }> = []
    for (const row of gp.regularOpeningHours?.periods || []) {
      const o = row.open
      if (!o || o.day == null || o.hour == null) continue
      const open = { day: o.day, hour: o.hour, minute: o.minute ?? 0 }
      const c = row.close
      const close =
        c && c.day != null && c.hour != null
          ? { day: c.day, hour: c.hour, minute: c.minute ?? 0 }
          : undefined
      openingPeriods.push({ open, close })
    }
    const rating =
      typeof gp.rating === 'number' && Number.isFinite(gp.rating)
        ? Math.round(gp.rating * 10) / 10
        : null

    res.status(200).json({
      place: {
        placeId: placeIdFromRaw(gp.id || placeId),
        name,
        address: String(gp.formattedAddress || '').trim().slice(0, 300),
        lat: Number.isFinite(lat) ? lat : hasBias ? latIn : null,
        lon: Number.isFinite(lon) ? lon : hasBias ? lonIn : null,
        category: categoryFromTypes(primary, types),
        primaryType: primary,
        rating,
        userRatingCount: typeof gp.userRatingCount === 'number' ? gp.userRatingCount : null,
        website: httpsUrl(gp.websiteUri || ''),
        googleMapsUri: httpsUrl(gp.googleMapsUri || ''),
        openingHours: openingHours || (openingPeriods.length ? 'Hours on file' : ''),
        openingPeriods: openingPeriods.length ? openingPeriods : undefined,
        photoName: String(gp.photos?.[0]?.name || '').slice(0, 512),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Place card failed'
    res.status(502).json({ error: msg })
  }
}
