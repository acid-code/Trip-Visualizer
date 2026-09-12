/**
 * Proxy for Places API (New) Text Search — map search bar pin drop.
 * One call per Enter; Essentials field mask (name / address / location).
 * Uses server GOOGLE_MAPS_API_KEY; client may pass apiKey only as a Data-panel override.
 */

import { searchTextPlaceGoogle } from '../src/data/placesGoogle'
import { serverGoogleMapsApiKey } from './_googleKey'

export const config = {
  maxDuration: 20,
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
  const apiKey = serverGoogleMapsApiKey(body.apiKey)
  const biasRaw = body.bias as { lat?: number; lon?: number; radiusM?: number } | undefined
  const bias =
    biasRaw &&
    Number.isFinite(biasRaw.lat) &&
    Number.isFinite(biasRaw.lon)
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
    const place = await searchTextPlaceGoogle({ query, apiKey, bias })
    res.status(200).json({ place })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Places Text failed'
    res.status(502).json({ error: msg })
  }
}
