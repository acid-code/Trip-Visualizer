import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

interface RouteCacheDB extends DBSchema {
  routes: {
    key: string
    value: {
      key: string
      profile: string
      coords: [number, number][]
      savedAt: number
    }
  }
}

let dbPromise: Promise<IDBPDatabase<RouteCacheDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<RouteCacheDB>('trip-tracker-routes', 1, {
      upgrade(database) {
        database.createObjectStore('routes', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export function routeCacheKey(
  profile: string,
  from: [number, number],
  to: [number, number],
): string {
  const r = (n: number) => n.toFixed(5)
  return `${profile}:${r(from[0])},${r(from[1])}->${r(to[0])},${r(to[1])}`
}

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

export async function getCachedRoute(
  key: string,
): Promise<[number, number][] | null> {
  try {
    const row = await (await db()).get('routes', key)
    if (!row) return null
    if (Date.now() - row.savedAt > MAX_AGE_MS) return null
    return row.coords
  } catch {
    return null
  }
}

export async function setCachedRoute(
  key: string,
  profile: string,
  coords: [number, number][],
): Promise<void> {
  try {
    await (
      await db()
    ).put('routes', {
      key,
      profile,
      coords,
      savedAt: Date.now(),
    })
  } catch {
    // ignore quota errors
  }
}
