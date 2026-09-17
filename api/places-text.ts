/**
 * Proxy for Places API (New) Text Search — map search + Plan recommendation lookup.
 * Fully self-contained: Vercel does not bundle ../src into /api functions.
 */

export const config = {
  maxDuration: 20,
}

const PLACES_TEXT = 'https://places.googleapis.com/v1/places:searchText'
const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.formattedAddress',
  'places.types',
  'places.primaryType',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.regularOpeningHours',
  'places.editorialSummary',
  'places.generativeSummary',
].join(',')

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
  formattedAddress?: string
  types?: string[]
  primaryType?: string
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
  editorialSummary?: { text?: string }
  generativeSummary?: {
    overview?: { text?: string }
    description?: { text?: string }
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
  if (
    has('park') ||
    has('campground') ||
    has('national_park') ||
    has('natural_feature') ||
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
  const query = String(body.query || '').trim()
  const apiKey = resolveApiKey(body.apiKey)
  const biasRaw = body.bias as { lat?: number; lon?: number; radiusM?: number } | undefined
  const bias =
    biasRaw && Number.isFinite(biasRaw.lat) && Number.isFinite(biasRaw.lon)
      ? {
          lat: Number(biasRaw.lat),
          lon: Number(biasRaw.lon),
          radiusM: biasRaw.radiusM,
        }
      : undefined

  if (!apiKey || !apiKey.startsWith('AIza')) {
    res.status(400).json({ error: 'Google Maps API key required' })
    return
  }
  if (!query || query.length > 200) {
    res.status(400).json({ error: 'Missing or oversized query' })
    return
  }

  try {
    const payload: Record<string, unknown> = {
      textQuery: query,
      languageCode: 'en',
      pageSize: 1,
      maxResultCount: 1,
    }
    if (bias) {
      payload.locationBias = {
        circle: {
          center: { latitude: bias.lat, longitude: bias.lon },
          radius: Math.min(Math.max(bias.radiusM ?? 50_000, 100), 50_000),
        },
      }
    }

    const upstream = await fetch(PLACES_TEXT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': TEXT_FIELD_MASK,
      },
      body: JSON.stringify(payload),
    })

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.status(502).json({
        error: `Places Text ${upstream.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      })
      return
    }

    const json = (await upstream.json()) as { places?: GooglePlace[] }
    const gp = json.places?.[0]
    if (!gp) {
      res.status(200).json({ place: null })
      return
    }
    const lat = gp.location?.latitude
    const lon = gp.location?.longitude
    const name = String(gp.displayName?.text || '').trim().slice(0, 120)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) {
      res.status(200).json({ place: null })
      return
    }

    const types = gp.types || []
    const primary = gp.primaryType || types[0] || ''
    const photoName = gp.photos?.[0]?.name || ''
    const rating =
      typeof gp.rating === 'number' && Number.isFinite(gp.rating)
        ? Math.round(gp.rating * 10) / 10
        : null
    const mapsUri = httpsUrl(gp.googleMapsUri || '')
    const website = httpsUrl(gp.websiteUri || '')
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
      const open = {
        day: o.day,
        hour: o.hour,
        minute: o.minute ?? 0,
      }
      const c = row.close
      const close =
        c && c.day != null && c.hour != null
          ? { day: c.day, hour: c.hour, minute: c.minute ?? 0 }
          : undefined
      openingPeriods.push({ open, close })
    }
    const editorial = String(gp.editorialSummary?.text || '').trim().slice(0, 500)
    const generative = String(
      gp.generativeSummary?.overview?.text ||
        gp.generativeSummary?.description?.text ||
        '',
    )
      .trim()
      .slice(0, 500)
    const summary = editorial || generative

    res.status(200).json({
      place: {
        lat,
        lon,
        name,
        address: String(gp.formattedAddress || '').trim().slice(0, 200),
        placeId: String(gp.id || '').trim().slice(0, 128),
        category: categoryFromTypes(primary, types),
        primaryType: primary,
        types,
        rating,
        userRatingCount:
          typeof gp.userRatingCount === 'number' ? gp.userRatingCount : null,
        photoName,
        googleMapsUri: mapsUri,
        website,
        openingHours:
          openingHours || (openingPeriods.length ? 'Hours on file' : ''),
        openingPeriods: openingPeriods.length ? openingPeriods : undefined,
        summary,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Places Text failed'
    res.status(502).json({ error: msg })
  }
}
