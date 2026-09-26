/**
 * Server proxy for LocationIQ Search (forward geocode).
 * The access token stays on the server so every user shares one egress IP.
 * LocationIQ's free plan meters distinct IPs; do not call them from the browser.
 */

export const config = {
  maxDuration: 20,
}

const LOCATIONIQ_SEARCH = 'https://us1.locationiq.com/v1/search'

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

type IqAddress = {
  tourism?: string
  amenity?: string
  leisure?: string
  shop?: string
  building?: string
  road?: string
  pedestrian?: string
  house_number?: string
  city?: string
  town?: string
  village?: string
  municipality?: string
  suburb?: string
  county?: string
}

export type LocationIqHit = {
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  osm_type?: string
  osm_id?: number | string
  address?: IqAddress
  extratags?: { website?: string; opening_hours?: string }
  error?: string
}

export type GeocodePlace = {
  lat: number
  lon: number
  name: string
  address: string
  city: string
  osmId: string
  website: string
  openingHours: string
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

function httpsUrl(raw: string): string {
  const s = raw.trim()
  if (!s.startsWith('https://') && !s.startsWith('http://')) return ''
  try {
    const u = new URL(s)
    if (u.protocol === 'http:') u.protocol = 'https:'
    return u.toString()
  } catch {
    return ''
  }
}

function cityFromAddress(addr?: IqAddress): string {
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

function nameFromHit(hit: LocationIqHit): string {
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

export function mapLocationIqHit(hit: LocationIqHit): GeocodePlace | null {
  const lat = Number(hit.lat)
  const lon = Number(hit.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const osmId =
    hit.osm_id == null ? '' : `${hit.osm_type ? `${hit.osm_type}/` : ''}${hit.osm_id}`
  return {
    lat,
    lon,
    name: nameFromHit(hit).slice(0, 160),
    address: String(hit.display_name || '').trim().slice(0, 300),
    city: cityFromAddress(hit.address).slice(0, 120),
    osmId: osmId.slice(0, 64),
    website: httpsUrl(hit.extratags?.website || '').slice(0, 300),
    openingHours: String(hit.extratags?.opening_hours || '').trim().slice(0, 800),
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

  const token = String(process.env.LOCATIONIQ_API_KEY ?? '').trim()
  if (!token) {
    res.status(200).json({ place: null, configured: false })
    return
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >
  const query = String(body.query || '').trim()
  if (!query || query.length > 300) {
    res.status(400).json({ error: 'Missing or oversized query' })
    return
  }

  const biasRaw = body.bias as { lat?: number; lon?: number; radiusM?: number } | undefined
  const bias =
    biasRaw && Number.isFinite(biasRaw.lat) && Number.isFinite(biasRaw.lon)
      ? { lat: Number(biasRaw.lat), lon: Number(biasRaw.lon), radiusM: biasRaw.radiusM }
      : undefined

  const url = new URL(LOCATIONIQ_SEARCH)
  url.searchParams.set('key', token)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('extratags', '1')
  url.searchParams.set('normalizecity', '1')
  url.searchParams.set('dedupe', '1')
  url.searchParams.set('limit', '1')
  url.searchParams.set('accept-language', 'en')
  if (bias) {
    const d = Math.min(Math.max((bias.radiusM ?? 50_000) / 111_000, 0.05), 1.5)
    url.searchParams.set(
      'viewbox',
      `${bias.lon - d},${bias.lat + d},${bias.lon + d},${bias.lat - d}`,
    )
    url.searchParams.set('bounded', '0')
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'trip-worker/0.1 (server geocode)' },
    })
    if (upstream.status === 404) {
      res.status(200).json({ place: null })
      return
    }
    if (upstream.status === 429) {
      res.status(200).json({ place: null, limited: true })
      return
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      res.status(502).json({
        error: `LocationIQ ${upstream.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      })
      return
    }
    const data = (await upstream.json()) as LocationIqHit[] | LocationIqHit
    const hit = Array.isArray(data) ? data[0] : data
    if (!hit || hit.error) {
      res.status(200).json({ place: null })
      return
    }
    res.status(200).json({ place: mapLocationIqHit(hit) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Geocode failed'
    res.status(502).json({ error: msg })
  }
}
