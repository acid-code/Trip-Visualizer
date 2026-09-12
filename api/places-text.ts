/**
 * Proxy for Places API (New) Text Search — map search bar pin drop.
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

    res.status(200).json({
      place: {
        lat,
        lon,
        name,
        address: String(gp.formattedAddress || '').trim().slice(0, 200),
        placeId: String(gp.id || '').trim().slice(0, 128),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Places Text failed'
    res.status(502).json({ error: msg })
  }
}
