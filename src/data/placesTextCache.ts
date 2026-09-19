/**
 * IndexedDB memo for Places Text Search hits — same query + bias shouldn't
 * re-bill Google within the TTL window.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { GoogleTextHit } from './placesGoogle'

interface PlacesTextCacheDB extends DBSchema {
  text: {
    key: string
    value: {
      key: string
      hit: GoogleTextHit | null
      savedAt: number
    }
  }
}

const TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 days
const NEGATIVE_TTL_MS = 1000 * 60 * 60 * 6 // empty hits expire sooner

let dbPromise: Promise<IDBPDatabase<PlacesTextCacheDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<PlacesTextCacheDB>('trip-tracker-places-text', 1, {
      upgrade(database) {
        database.createObjectStore('text', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export function placesTextCacheKey(
  query: string,
  bias?: { lat: number; lon: number; radiusM?: number },
): string {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
  if (!bias) return `v1:${q}`
  const r = Math.round((bias.radiusM ?? 50_000) / 5_000) * 5_000
  return `v1:${q}@${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}:${r}`
}

export async function getCachedTextHit(
  key: string,
): Promise<GoogleTextHit | null | undefined> {
  try {
    const row = await (await db()).get('text', key)
    if (!row) return undefined
    const ttl = row.hit ? TTL_MS : NEGATIVE_TTL_MS
    if (Date.now() - row.savedAt > ttl) return undefined
    return row.hit
  } catch {
    return undefined
  }
}

export async function setCachedTextHit(
  key: string,
  hit: GoogleTextHit | null,
): Promise<void> {
  try {
    await (await db()).put('text', { key, hit, savedAt: Date.now() })
  } catch {
    /* ignore quota */
  }
}
