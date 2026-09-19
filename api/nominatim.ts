/**
 * Server-side Nominatim proxy — browsers cannot set User-Agent (forbidden header),
 * which leads to weak/empty results from the public OSM endpoint.
 * GET /api/nominatim?q=… or ?lat=&lon= for reverse.
 */

export const config = {
  maxDuration: 15,
}

const SEARCH = 'https://nominatim.openstreetmap.org/search'
const REVERSE = 'https://nominatim.openstreetmap.org/reverse'
const UA =
  'trip-worker/0.1 (personal offline-first trip journal; contact via github issues)'

type VercelReq = {
  method?: string
  query?: Record<string, string | string[] | undefined>
  url?: string
}

type VercelRes = {
  status: (code: number) => VercelRes
  setHeader: (name: string, value: string) => void
  json: (body: unknown) => void
  send: (body: string) => void
}

let lastAt = 0

async function throttle() {
  const wait = Math.max(0, 1100 - (Date.now() - lastAt))
  if (wait) await new Promise((r) => setTimeout(r, wait))
  lastAt = Date.now()
}

function qParam(
  query: VercelReq['query'],
  name: string,
): string {
  const raw = query?.[name]
  if (Array.isArray(raw)) return String(raw[0] || '').trim()
  return String(raw || '').trim()
}

function parseQueryFromUrl(url?: string): Record<string, string> {
  if (!url) return {}
  try {
    const u = new URL(url, 'http://localhost')
    const out: Record<string, string> = {}
    u.searchParams.forEach((v, k) => {
      out[k] = v
    })
    return out
  } catch {
    return {}
  }
}

export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' })
    return
  }

  const fromUrl = parseQueryFromUrl(req.url)
  const get = (name: string) =>
    qParam(req.query, name) || fromUrl[name] || ''

  const lat = get('lat')
  const lon = get('lon')
  const q = get('q').slice(0, 300)
  const viewbox = get('viewbox').slice(0, 120)
  const limit = Math.min(Math.max(Number(get('limit')) || 3, 1), 5)

  let upstreamUrl: string
  if (lat && lon) {
    const u = new URL(REVERSE)
    u.searchParams.set('lat', lat)
    u.searchParams.set('lon', lon)
    u.searchParams.set('format', 'json')
    u.searchParams.set('addressdetails', '1')
    u.searchParams.set('zoom', get('zoom') || '18')
    upstreamUrl = u.toString()
  } else if (q) {
    const u = new URL(SEARCH)
    u.searchParams.set('q', q)
    u.searchParams.set('format', 'json')
    u.searchParams.set('addressdetails', '1')
    u.searchParams.set('limit', String(limit))
    if (viewbox) u.searchParams.set('viewbox', viewbox)
    // Soft bias only — do not set bounded=1 (that causes empty [] when off-box)
    upstreamUrl = u.toString()
  } else {
    res.status(400).json({ error: 'Provide q= or lat=&lon=' })
    return
  }

  try {
    await throttle()
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    })
    const text = await upstream.text()
    if (!upstream.ok) {
      res.status(502).json({
        error: `Nominatim HTTP ${upstream.status}`,
        detail: text.slice(0, 200),
      })
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.status(200).send(text)
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Nominatim proxy failed',
    })
  }
}
