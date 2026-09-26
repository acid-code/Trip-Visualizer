/**
 * Google place-card fetch. Text Search is IDs-only; details are Place Details
 * Enterprise. Cached so reopening a place does not bill again.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ExploreCategory, ExplorePlace } from './explore'
import type { OpeningPeriod } from './openingHours'
import { googlePlacePhotoMediaUrl } from './placesGoogle'
import { logClientError, sanitizeSecretInput } from './security'

export type PlaceCard = {
  placeId: string
  name: string
  address: string
  lat: number | null
  lon: number | null
  category: ExploreCategory
  rating: number | null
  userRatingCount: number | null
  website: string
  googleMapsUri: string
  openingHours: string
  openingPeriods?: OpeningPeriod[]
  photoName: string
}

const CATEGORIES = new Set<ExploreCategory>([
  'sights',
  'activity',
  'food',
  'drink',
  'hotel',
  'nature',
  'other',
])

const HIT_TTL_MS = 1000 * 60 * 60 * 24 * 30
const MISS_TTL_MS = 1000 * 60 * 10

interface PlaceCardDB extends DBSchema {
  card: {
    key: string
    value: { key: string; card: PlaceCard | null; savedAt: number }
  }
}

let dbPromise: Promise<IDBPDatabase<PlaceCardDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<PlaceCardDB>('trip-tracker-place-card', 1, {
      upgrade(database) {
        database.createObjectStore('card', { keyPath: 'key' })
      },
    })
  }
  return dbPromise
}

function normQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
}

export function placeCardCacheKeys(opts: {
  query: string
  altQuery?: string
  lat?: number
  lon?: number
}): string[] {
  const keys: string[] = []
  const add = (q: string) => {
    const n = normQuery(q)
    if (!n) return
    keys.push(`q:${n}`)
    if (opts.lat != null && opts.lon != null && Number.isFinite(opts.lat) && Number.isFinite(opts.lon)) {
      keys.push(`p:${n}@${opts.lat.toFixed(3)},${opts.lon.toFixed(3)}`)
    }
  }
  add(opts.query)
  if (opts.altQuery) add(opts.altQuery)
  return [...new Set(keys)]
}

async function readCache(keys: string[]): Promise<PlaceCard | null | undefined> {
  try {
    const store = await db()
    for (const key of keys) {
      const row = await store.get('card', key)
      if (!row) continue
      const ttl = row.card ? HIT_TTL_MS : MISS_TTL_MS
      if (Date.now() - row.savedAt > ttl) continue
      return row.card
    }
    return undefined
  } catch {
    return undefined
  }
}

async function writeCache(keys: string[], card: PlaceCard | null): Promise<void> {
  try {
    const store = await db()
    const savedAt = Date.now()
    await Promise.all(keys.map((key) => store.put('card', { key, card, savedAt })))
  } catch {
    /* ignore quota */
  }
}

function asCategory(raw: string): ExploreCategory {
  return CATEGORIES.has(raw as ExploreCategory) ? (raw as ExploreCategory) : 'other'
}

export function mergeExplorePlaceCard(place: ExplorePlace, card: PlaceCard): ExplorePlace {
  const photoUrl = card.photoName ? googlePlacePhotoMediaUrl(card.photoName) : ''
  const reviewBlurb =
    card.userRatingCount && card.userRatingCount > 0
      ? `${card.userRatingCount} Google reviews`
      : ''
  const category =
    card.category && card.category !== 'other' ? card.category : place.category
  return {
    ...place,
    name: card.name || place.name,
    address: card.address || place.address,
    category,
    rating: card.rating ?? place.rating,
    website: card.website || place.website,
    openingHours: card.openingHours || place.openingHours,
    openingPeriods: card.openingPeriods?.length ? card.openingPeriods : place.openingPeriods,
    summary: place.summary || reviewBlurb,
    images: place.images.length ? place.images : photoUrl ? [photoUrl] : [],
    osmId: card.placeId ? `google:${card.placeId}` : place.osmId,
    osmType: card.placeId ? 'google' : place.osmType,
    tags: {
      ...place.tags,
      source: card.placeId ? 'google' : place.tags.source || 'search',
      cardFetched: '1',
      ...(card.placeId ? { googlePlaceId: card.placeId } : {}),
      ...(card.googleMapsUri ? { googleMapsUri: card.googleMapsUri } : {}),
      ...(card.photoName ? { googlePhotoName: card.photoName } : {}),
    },
  }
}

export async function fetchPlaceCard(opts: {
  query: string
  altQuery?: string
  lat?: number
  lon?: number
  placeId?: string
  apiKey?: string
}): Promise<PlaceCard | null> {
  const query = opts.query.trim()
  if (!query && !opts.placeId) return null
  const keys = placeCardCacheKeys(opts)
  const cached = await readCache(keys)
  if (cached !== undefined) return cached

  const override = sanitizeSecretInput(opts.apiKey ?? '')
  try {
    const res = await fetch('/api/places-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query,
        altQuery: opts.altQuery,
        lat: opts.lat,
        lon: opts.lon,
        placeId: opts.placeId,
        ...(override ? { apiKey: override } : {}),
      }),
    })
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null
      logClientError('place-card', errBody?.error || `Place card ${res.status}`)
      return null
    }
    const json = (await res.json()) as { place?: PlaceCard | null; configured?: boolean }
    if (json.configured === false) return null
    const raw = json.place
    const card: PlaceCard | null = raw
      ? {
          ...raw,
          category: asCategory(String(raw.category || 'other')),
          name: String(raw.name || ''),
          address: String(raw.address || ''),
          placeId: String(raw.placeId || ''),
          website: String(raw.website || ''),
          googleMapsUri: String(raw.googleMapsUri || ''),
          openingHours: String(raw.openingHours || ''),
          photoName: String(raw.photoName || ''),
          rating: typeof raw.rating === 'number' ? raw.rating : null,
          userRatingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
        }
      : null
    const writeKeys = [...keys]
    if (card?.name) {
      writeKeys.push(
        ...placeCardCacheKeys({
          query: card.name,
          lat: card.lat ?? opts.lat,
          lon: card.lon ?? opts.lon,
        }),
      )
    }
    await writeCache([...new Set(writeKeys)], card)
    return card
  } catch (err) {
    logClientError('place-card', err)
    return null
  }
}
