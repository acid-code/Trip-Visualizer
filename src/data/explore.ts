/** Nearby Explore places via Overpass (OSM) + optional Wikidata photos — no API key. */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ItemType } from '../domain/types'
import { fetchWikidataSummary } from './enrichment'
import { distKm } from './routes'
import { clampText, logClientError, safeHttpsUrl } from './security'
import { isValidCoord } from './validate'

export type ExploreCategory = 'sights' | 'food' | 'drink' | 'nature' | 'other'

export type ExplorePlace = {
  id: string
  name: string
  lat: number
  lon: number
  category: ExploreCategory
  osmType: string
  osmId: string
  wikidata: string
  images: string[]
  summary: string
  distKm: number
  rating: number | null
  cuisine: string
  website: string
  /** Direct menu URL from OSM when tagged */
  menuUrl: string
  openingHours: string
  address: string
  tags: Record<string, string>
}

export type ExploreSort = 'distance' | 'name' | 'rating'

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const DEFAULT_RADIUS_M = 1500
const DEFAULT_LIMIT = 40
const CACHE_TTL_MS = 1000 * 60 * 60 * 48 // 2 days — reuse nearby results quickly

const CATEGORY_QUERIES: Record<ExploreCategory, string[]> = {
  sights: [
    'nwr["tourism"="attraction"]',
    'nwr["tourism"="museum"]',
    'nwr["tourism"="viewpoint"]',
    'nwr["tourism"="artwork"]',
    'nwr["tourism"="gallery"]',
    'nwr["tourism"="zoo"]',
    'nwr["tourism"="theme_park"]',
    'nwr["historic"]',
  ],
  food: [
    'nwr["amenity"="restaurant"]',
    'nwr["amenity"="cafe"]',
    'nwr["amenity"="fast_food"]',
    'nwr["amenity"="ice_cream"]',
  ],
  drink: [
    'nwr["amenity"="bar"]',
    'nwr["amenity"="pub"]',
    'nwr["amenity"="biergarten"]',
  ],
  nature: [
    'nwr["leisure"="park"]',
    'nwr["leisure"="nature_reserve"]',
    'nwr["tourism"="picnic_site"]',
    'nwr["natural"="beach"]',
  ],
  other: [
    'nwr["tourism"="hotel"]',
    'nwr["shop"="bakery"]',
    'nwr["amenity"="marketplace"]',
    'nwr["leisure"="playground"]',
  ],
}

interface ExploreCacheDB extends DBSchema {
  explore: {
    key: string
    value: {
      key: string
      places: ExplorePlace[]
      savedAt: number
    }
  }
}

let cacheDbPromise: Promise<IDBPDatabase<ExploreCacheDB>> | null = null

function cacheDb() {
  if (!cacheDbPromise) {
    cacheDbPromise = openDB<ExploreCacheDB>('trip-tracker-explore', 1, {
      upgrade(database) {
        database.createObjectStore('explore', { keyPath: 'key' })
      },
    })
  }
  return cacheDbPromise
}

function cacheKey(lat: number, lon: number, radiusM: number): string {
  // ~1 km cells so nearby pins share the same explore cache
  return `${lat.toFixed(2)},${lon.toFixed(2)}:${radiusM}`
}

async function getCached(key: string): Promise<ExplorePlace[] | null> {
  try {
    const row = await (await cacheDb()).get('explore', key)
    if (!row) return null
    if (Date.now() - row.savedAt > CACHE_TTL_MS) return null
    return row.places.map((p) => ({
      ...p,
      images: p.images ?? [],
      menuUrl: p.menuUrl ?? '',
    }))
  } catch {
    return null
  }
}

async function setCached(key: string, places: ExplorePlace[]): Promise<void> {
  try {
    await (await cacheDb()).put('explore', { key, places, savedAt: Date.now() })
  } catch {
    /* ignore quota */
  }
}

type OverpassElement = {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

function categoryForTags(tags: Record<string, string>): ExploreCategory {
  const tourism = tags.tourism || ''
  const amenity = tags.amenity || ''
  const leisure = tags.leisure || ''
  const natural = tags.natural || ''
  if (
    ['attraction', 'museum', 'viewpoint', 'artwork', 'gallery', 'zoo', 'theme_park'].includes(
      tourism,
    ) ||
    tags.historic
  ) {
    return 'sights'
  }
  if (['restaurant', 'cafe', 'fast_food', 'ice_cream'].includes(amenity)) return 'food'
  if (['bar', 'pub', 'biergarten'].includes(amenity)) return 'drink'
  if (
    ['park', 'nature_reserve'].includes(leisure) ||
    tourism === 'picnic_site' ||
    natural === 'beach'
  ) {
    return 'nature'
  }
  return 'other'
}

function parseStars(tags: Record<string, string>): number | null {
  const raw = tags.stars || tags['stars:Michelin'] || tags.rating
  if (!raw) return null
  const n = parseFloat(String(raw).replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(5, Math.round(n * 10) / 10)
}

function commonsFileUrl(file: string): string {
  const name = file.replace(/^File:/i, '').trim()
  if (!name) return ''
  return safeHttpsUrl(
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=640`,
  )
}

function addressFromTags(tags: Record<string, string>): string {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
    tags['addr:postcode'],
  ].filter(Boolean)
  return parts.join(', ')
}

function elementToPlace(
  el: OverpassElement,
  anchor: { lat: number; lon: number },
): ExplorePlace | null {
  const tags = el.tags || {}
  const lat = el.lat ?? el.center?.lat
  const lon = el.lon ?? el.center?.lon
  if (!isValidCoord(lat, lon)) return null
  const name = clampText(tags.name || tags['name:en'] || tags.brand || '', 120)
  if (!name) return null

  const images: string[] = []
  if (tags.image) {
    const u = safeHttpsUrl(tags.image)
    if (u) images.push(u)
  }
  if (tags.wikimedia_commons) {
    const u = commonsFileUrl(tags.wikimedia_commons)
    if (u && !images.includes(u)) images.push(u)
  }

  const osmId = `${el.type}/${el.id}`
  return {
    id: `osm:${osmId}`,
    name,
    lat: lat!,
    lon: lon!,
    category: categoryForTags(tags),
    osmType: el.type,
    osmId,
    wikidata: clampText(tags.wikidata || '', 32),
    images,
    summary: '',
    distKm: distKm(anchor, { lat: lat!, lon: lon! }),
    rating: parseStars(tags),
    cuisine: clampText(tags.cuisine || '', 80),
    website: safeHttpsUrl(tags.website || tags['contact:website'] || ''),
    menuUrl: safeHttpsUrl(
      tags['website:menu'] || tags['contact:menu'] || tags.menu || '',
    ),
    openingHours: clampText(tags.opening_hours || '', 120),
    address: clampText(addressFromTags(tags), 200),
    tags,
  }
}

function buildOverpassQuery(lat: number, lon: number, radiusM: number): string {
  const parts: string[] = []
  for (const cat of Object.keys(CATEGORY_QUERIES) as ExploreCategory[]) {
    for (const selector of CATEGORY_QUERIES[cat]) {
      parts.push(`${selector}(around:${radiusM},${lat},${lon});`)
    }
  }
  return `
[out:json][timeout:25];
// trip-worker explore — personal offline-first journal
(
${parts.join('\n')}
);
out center tags;
`.trim()
}

async function queryOverpass(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  let lastErr: unknown
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      })
      if (!res.ok) {
        lastErr = new Error(`Overpass ${res.status}`)
        continue
      }
      const json = (await res.json()) as { elements?: OverpassElement[] }
      return json.elements ?? []
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
    }
  }
  logClientError('explore-overpass', lastErr)
  throw lastErr instanceof Error ? lastErr : new Error('Overpass failed')
}

async function enrichImages(
  places: ExplorePlace[],
  signal?: AbortSignal,
): Promise<ExplorePlace[]> {
  const need = places.filter((p) => p.wikidata && p.images.length === 0).slice(0, 18)
  const out = places.map((p) => ({ ...p, images: [...p.images] }))
  for (const place of need) {
    if (signal?.aborted) break
    try {
      const wiki = await fetchWikidataSummary(place.wikidata)
      if (!wiki) continue
      const idx = out.findIndex((p) => p.id === place.id)
      if (idx < 0) continue
      const cur = out[idx]!
      const image = wiki.image ? safeHttpsUrl(wiki.image) : ''
      out[idx] = {
        ...cur,
        summary: cur.summary || clampText(wiki.summary, 400),
        wikidata: cur.wikidata || wiki.id,
        images: image ? [image, ...cur.images] : cur.images,
      }
      await new Promise((r) => setTimeout(r, 120))
    } catch {
      /* skip */
    }
  }
  return out
}

export async function fetchNearbyExplore(
  anchor: { lat: number; lon: number },
  opts?: {
    radiusM?: number
    limit?: number
    signal?: AbortSignal
    skipCache?: boolean
    /** Fired immediately when a 2-day area cache hit exists (before network). */
    onCacheHit?: (places: ExplorePlace[]) => void
    /** After a cache hit, still refresh Overpass in the background (default true). */
    refreshInBackground?: boolean
  },
): Promise<ExplorePlace[]> {
  if (!isValidCoord(anchor.lat, anchor.lon)) return []
  const radiusM = opts?.radiusM ?? DEFAULT_RADIUS_M
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const key = cacheKey(anchor.lat, anchor.lon, radiusM)

  const withDistances = (list: ExplorePlace[]) =>
    [...list]
      .map((p) => ({
        ...p,
        distKm: distKm(anchor, { lat: p.lat, lon: p.lon }),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, limit)

  let cacheHit: ExplorePlace[] | null = null
  if (!opts?.skipCache) {
    const cached = await getCached(key)
    if (cached?.length) {
      cacheHit = withDistances(cached)
      opts?.onCacheHit?.(cacheHit)
      if (opts?.refreshInBackground === false) return cacheHit
    }
  }

  try {
    const elements = await queryOverpass(
      buildOverpassQuery(anchor.lat, anchor.lon, radiusM),
      opts?.signal,
    )
    if (opts?.signal?.aborted) return cacheHit ?? []

    const seen = new Set<string>()
    const places: ExplorePlace[] = []
    for (const el of elements) {
      const place = elementToPlace(el, anchor)
      if (!place || seen.has(place.id)) continue
      seen.add(place.id)
      places.push(place)
    }
    places.sort((a, b) => a.distKm - b.distKm)
    const trimmed = places.slice(0, limit)
    const enriched = await enrichImages(trimmed, opts?.signal)
    if (opts?.signal?.aborted) return cacheHit ?? enriched
    const fresh = withDistances(enriched)
    void setCached(key, fresh)
    return fresh
  } catch (err) {
    if (cacheHit) return cacheHit
    throw err
  }
}

export function filterAndSortExplore(
  places: ExplorePlace[],
  type: ExploreCategory | 'all',
  sort: ExploreSort,
): ExplorePlace[] {
  let list = type === 'all' ? [...places] : places.filter((p) => p.category === type)
  if (sort === 'name') {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name))
  } else if (sort === 'rating') {
    list = [...list].sort((a, b) => {
      const ar = a.rating ?? -1
      const br = b.rating ?? -1
      if (br !== ar) return br - ar
      return a.distKm - b.distKm
    })
  } else {
    list = [...list].sort((a, b) => a.distKm - b.distKm)
  }
  return list
}

export function exploreCategoryLabel(cat: ExploreCategory): string {
  switch (cat) {
    case 'sights':
      return 'Sights'
    case 'food':
      return 'Food'
    case 'drink':
      return 'Drink'
    case 'nature':
      return 'Nature'
    default:
      return 'Other'
  }
}

export function explorePlaceToItemType(place: ExplorePlace): ItemType {
  switch (place.category) {
    case 'food':
    case 'drink':
      return 'restaurant'
    case 'nature':
      return 'activity'
    case 'sights':
      return 'sight'
    default:
      return 'other'
  }
}
