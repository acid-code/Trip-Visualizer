/**
 * Proxy for Places API (New) Nearby Search — avoids browser CORS.
 * Client may pass apiKey (Data override / VITE key); else server env is used.
 */

import {
  searchNearbyPlacesGoogle,
  GOOGLE_NEARBY_MAX,
} from '../src/data/placesGoogle'

export const config = {
  maxDuration: 30,
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

function header(req: VercelReq, name: string): string {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0] || ''
  return typeof raw === 'string' ? raw : ''
}

function originAllowed(req: VercelReq): boolean {
  const origin = header(req, 'origin') || header(req, 'referer')
  if (!origin) return true // non-browser / same-origin edge cases
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
  const apiKey = String(
    body.apiKey ||
      process.env.GOOGLE_MAPS_API_KEY ||
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      '',
  ).trim()

  if (!apiKey || !apiKey.startsWith('AIza')) {
    res.status(400).json({ error: 'Google Maps API key required' })
    return
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Invalid coordinates' })
    return
  }

  try {
    const places = await searchNearbyPlacesGoogle({
      lat,
      lon,
      radiusM,
      maxResultCount,
      apiKey,
    })
    res.status(200).json({ places })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Places Nearby failed'
    res.status(502).json({ error: msg })
  }
}
