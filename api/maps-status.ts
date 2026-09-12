/**
 * Lightweight probe: whether Places works via server-held GOOGLE_MAPS_API_KEY.
 * Never returns the key itself.
 */

import { serverPlacesConfigured } from '../lib/serverGoogleKey'

export const config = {
  maxDuration: 5,
}

type VercelReq = {
  method?: string
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
  try {
    res.setHeader('Cache-Control', 'no-store')

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

    res.status(200).json({ placesConfigured: serverPlacesConfigured() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'maps-status failed'
    res.status(500).json({ error: msg, placesConfigured: false })
  }
}
