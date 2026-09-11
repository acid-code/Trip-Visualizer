/**
 * Server-side Overpass proxy — browsers hit CORS / 406 talking to public Overpass.
 * Vercel Node function forwards with an identifying User-Agent.
 */

export const config = {
  maxDuration: 30,
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const UA = 'trip-worker/0.1 (personal offline-first trip journal; +https://github.com/)'

type VercelReq = {
  method?: string
  body?: unknown
}

type VercelRes = {
  status: (code: number) => VercelRes
  setHeader: (name: string, value: string) => void
  json: (body: unknown) => void
  send: (body: string) => void
}

function extractQuery(body: unknown): string {
  if (typeof body === 'string') {
    const params = new URLSearchParams(body)
    return params.get('data') || body
  }
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    if (typeof rec.data === 'string') return rec.data
    if (typeof rec.query === 'string') return rec.query
  }
  return ''
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

  const query = extractQuery(req.body).trim()
  if (!query || query.length > 100_000) {
    res.status(400).json({ error: 'Missing or oversized Overpass query' })
    return
  }

  // Basic allowlist — only read-only Overpass scripts we generate
  if (!query.includes('[out:json]') || /\[out:xml\]|out\s+meta/i.test(query)) {
    res.status(400).json({ error: 'Unsupported Overpass query' })
    return
  }

  let lastErr = 'Overpass failed'
  for (const endpoint of ENDPOINTS) {
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
          'User-Agent': UA,
        },
        body: `data=${encodeURIComponent(query)}`,
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        lastErr = `Overpass ${upstream.status}`
        continue
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.status(200).send(text)
      return
    } catch (err) {
      lastErr = err instanceof Error ? err.message : 'Overpass network error'
    }
  }

  res.status(502).json({ error: lastErr })
}
