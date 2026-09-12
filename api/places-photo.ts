/**
 * Same-origin Place Photo proxy — keeps GOOGLE_MAPS_API_KEY off the client.
 * GET /api/places-photo?name=places/.../photos/...&maxWidthPx=640
 */

import { serverGoogleMapsApiKey } from '../lib/serverGoogleKey'

export const config = {
  maxDuration: 20,
}

type VercelReq = {
  method?: string
  query?: Record<string, string | string[] | undefined>
  headers?: Record<string, string | string[] | undefined>
}

type VercelRes = {
  status: (code: number) => VercelRes
  setHeader: (name: string, value: string) => void
  json: (body: unknown) => void
  send: (body: string | Buffer) => void
  end: (body?: string | Buffer) => void
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

function queryParam(req: VercelReq, key: string): string {
  const raw = req.query?.[key]
  if (Array.isArray(raw)) return raw[0] || ''
  return typeof raw === 'string' ? raw : ''
}

const PHOTO_NAME_RE = /^places\/[^/]+\/photos\/[^/]+$/

export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader('Cache-Control', 'public, max-age=86400')

  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' })
    return
  }
  if (!originAllowed(req)) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }

  const name = queryParam(req, 'name').replace(/^\//, '')
  const maxWidthPx = Math.min(
    Math.max(Number(queryParam(req, 'maxWidthPx')) || 640, 1),
    1600,
  )
  const apiKey = serverGoogleMapsApiKey()

  if (!PHOTO_NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid photo name' })
    return
  }
  if (!apiKey.startsWith('AIza')) {
    res.status(400).json({ error: 'Google Maps API key not configured on server' })
    return
  }

  try {
    const url = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`
    const upstream = await fetch(url, { redirect: 'follow' })
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Photo fetch failed' })
      return
    }
    const ct = upstream.headers.get('content-type') || 'image/jpeg'
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.setHeader('Content-Type', ct)
    res.status(200).send(buf)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Photo proxy failed'
    res.status(502).json({ error: msg })
  }
}
