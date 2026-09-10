import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { TripItem, TripMeta, TripRecord } from '../domain/types'
import {
  EXAMPLE_TRIP_ID,
  exampleItems,
  exampleMeta,
} from './examples/france-south-loop'

interface TripDB extends DBSchema {
  trips: {
    key: string
    value: TripRecord
    indexes: { 'by-updated': string }
  }
  settings: {
    key: string
    value: { key: string; value: string }
  }
}

let dbPromise: Promise<IDBPDatabase<TripDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<TripDB>('trip-tracker', 1, {
      upgrade(database) {
        const trips = database.createObjectStore('trips', { keyPath: 'id' })
        trips.createIndex('by-updated', 'updatedAt')
        database.createObjectStore('settings', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

export function createId(prefix = 'T'): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

export async function listTrips(): Promise<TripRecord[]> {
  const database = await db()
  const all = await database.getAll('trips')
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getTrip(id: string): Promise<TripRecord | undefined> {
  const database = await db()
  return database.get('trips', id)
}

export async function saveTrip(trip: TripRecord): Promise<void> {
  const database = await db()
  await database.put('trips', {
    ...trip,
    updatedAt: nowIso(),
  })
}

export async function deleteTrip(id: string): Promise<void> {
  const database = await db()
  await database.delete('trips', id)
}

export function makeTrip(
  meta: TripMeta,
  items: TripItem[],
  opts?: Partial<Pick<TripRecord, 'id' | 'isExample'>>,
): TripRecord {
  const stamp = nowIso()
  return {
    id: opts?.id ?? createId('TRIP'),
    meta,
    items,
    isExample: opts?.isExample ?? false,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

export async function ensureExampleTrip(): Promise<TripRecord> {
  const existing = await getTrip(EXAMPLE_TRIP_ID)
  if (existing) return existing
  const trip = makeTrip(exampleMeta, structuredClone(exampleItems), {
    id: EXAMPLE_TRIP_ID,
    isExample: true,
  })
  await saveTrip(trip)
  return trip
}

export async function duplicateTrip(source: TripRecord): Promise<TripRecord> {
  const copy = makeTrip(
    {
      ...source.meta,
      name: source.isExample
        ? `${source.meta.name} (my copy)`
        : `${source.meta.name} (copy)`,
    },
    source.items.map((item) => ({
      ...item,
      id: createId(item.type[0]?.toUpperCase() ?? 'X'),
      source: 'app',
    })),
    { isExample: false },
  )
  await saveTrip(copy)
  return copy
}

export async function createBlankTrip(): Promise<TripRecord> {
  const today = new Date().toISOString().slice(0, 10)
  const trip = makeTrip(
    {
      name: 'New trip',
      startDate: today,
      endDate: today,
      homeCurrency: 'EUR',
      timezoneNote: 'All times are local',
      travelers: '',
      notes: '',
    },
    [],
    { isExample: false },
  )
  await saveTrip(trip)
  return trip
}

export async function getSetting(key: string): Promise<string | undefined> {
  const database = await db()
  const row = await database.get('settings', key)
  return row?.value
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await db()
  await database.put('settings', { key, value })
}

export function sortItems(items: TripItem[]): TripItem[] {
  return [...items].sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    if (d !== 0) return d
    const sa = a.start || '99:99'
    const sb = b.start || '99:99'
    return sa.localeCompare(sb)
  })
}
