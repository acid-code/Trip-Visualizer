/**
 * LocationIQ forward geocode via /api/geocode.
 * Responses are cached 48 hours — the free plan's limit for request/response pairs.
 * Resolved coordinates stored on a trip are the place itself and are not this cache.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export type GeocodeHit = {
  lat: number
  lon: number
  name: string
  address: string
  city: string
  osmId: string
  website: string
  openingHours: string
}

type CacheRow = {
  key: string
  hit: GeocodeHit | null
  savedAt: number
}

interface GeocodeCacheDB extends DBSchema {
  geocode: {
    key: string
    value: CacheRow
  }
}

const HIT_TTL_MS = 1000 * 60 * 60 * 48
const MISS_TTL_MS = 1000 * 60 * 2
const MIN_GAP_MS = 520

let dbPromise: Promise<IDBPDatabase<GeocodeCacheDB>> | null = null
let lastCallAt = 0
let chain: Promise<unknown> = Promise.resolve()
let locationIqDisabled = false

function db() {
  if (!dbPromise) {
    dbPromise = openDB<GeocodeCacheDB>('trip-tracker-geocode', 1, {
      upgrade(database) {
        database.createObjectStore('geocode', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export function geocodeCacheKey(
  query: string,
  bias?: { lat: number; lon: number; radiusM?: number },
): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
  if (!bias) return `v1:${q}`
  const r = Math.round((bias.radiusM ?? 50_000) / 5_000) * 5_000
  return `v1:${q}@${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}:${r}`
}

async function readCache(key: string): Promise<GeocodeHit | null | undefined> {
  try {
    const row = await (await db()).get('geocode', key)
    if (!row) return undefined
    const ttl = row.hit ? HIT_TTL_MS : MISS_TTL_MS
    if (Date.now() - row.savedAt > ttl) return undefined
    return row.hit
  } catch {
    return undefined
  }
}

async function writeCache(key: string, hit: GeocodeHit | null): Promise<void> {
  try {
    await (await db()).put('geocode', { key, hit, savedAt: Date.now() })
  } catch {
    /* ignore quota */
  }
}

function pace(): Promise<void> {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt))
    if (wait) await new Promise((r) => setTimeout(r, wait))
    lastCallAt = Date.now()
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function geocodeViaProxy(
  query: string,
  bias?: { lat: number; lon: number; radiusM?: number },
): Promise<GeocodeHit | null> {
  const q = query.trim()
  if (!q || locationIqDisabled) return null
  const key = geocodeCacheKey(q, bias)
  const cached = await readCache(key)
  if (cached !== undefined) return cached

  await pace()
  const res = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: q.slice(0, 300), bias }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { place?: GeocodeHit | null; configured?: boolean }
  if (json.configured === false) {
    locationIqDisabled = true
    return null
  }
  const place = json.place ?? null
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    await writeCache(key, place)
    return place
  }
  await writeCache(key, null)
  return null
}
