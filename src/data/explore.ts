/** Nearby Explore places via Overpass (OSM) + Wikimedia / Wikipedia photos — no API key. */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ItemType } from '../domain/types'
import { distKm } from './routes'
import { clampText, logClientError, safeHttpsUrl } from './security'
import { isValidCoord } from './validate'
import {
  attachGoogleListPhotos,
  fetchGoogleNearbyViaProxy,
  GOOGLE_NEARBY_MAX,
} from './placesGoogle'

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

/** Same-origin proxy on Vercel (and Vite dev) — avoids browser CORS / 406. */
const OVERPASS_PROXY = '/api/overpass'

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

function cacheKey(
  lat: number,
  lon: number,
  radiusM: number,
  source: 'google' | 'osm',
): string {
  // v5: Google Nearby (one Pro call) or OSM; bump when pipeline changes
  return `v5:${source}:${lat.toFixed(2)},${lon.toFixed(2)}:${radiusM}`
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

function pushImage(list: string[], raw: string | undefined | null) {
  if (!raw) return
  const t = raw.trim()
  if (!t) return
  let url = ''
  if (/^https?:\/\//i.test(t)) {
    url = safeHttpsUrl(t)
  } else if (/^File:/i.test(t) || /\.(jpe?g|png|gif|webp|svg)$/i.test(t)) {
    url = commonsFileUrl(t)
  } else if (!/^Category:/i.test(t) && t.includes('.')) {
    url = commonsFileUrl(t)
  }
  if (url && !list.includes(url)) list.push(url)
}

/** Collect direct image URLs already on the OSM object. */
function imagesFromTags(tags: Record<string, string>): string[] {
  const images: string[] = []
  pushImage(images, tags.image)
  for (const [key, value] of Object.entries(tags)) {
    if (/^image:\d+$/i.test(key)) pushImage(images, value)
  }
  const wc = tags.wikimedia_commons || ''
  if (wc && !/^Category:/i.test(wc)) pushImage(images, wc)
  // Some POIs store a Wikimedia page URL in `image` already handled above
  return images.slice(0, 6)
}

function commonsCategoryTitle(tags: Record<string, string>): string {
  const wc = tags.wikimedia_commons || ''
  if (/^Category:/i.test(wc)) return wc
  return ''
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
    images: imagesFromTags(tags),
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
  // Same-origin /api/overpass (Vercel function or Vite proxy) — public Overpass blocks browsers
  try {
    const res = await fetch(OVERPASS_PROXY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    })
    if (!res.ok) {
      throw new Error(`Overpass ${res.status}`)
    }
    const json = (await res.json()) as { elements?: OverpassElement[]; error?: string }
    if (json.error && !json.elements) {
      throw new Error(json.error)
    }
    return json.elements ?? []
  } catch (err) {
    if (signal?.aborted) throw err
    logClientError('explore-overpass', err)
    throw err instanceof Error ? err : new Error('Overpass failed')
  }
}

type WikiEntityLite = {
  id: string
  summary: string
  images: string[]
}

/** Batch-fetch Wikidata P18 images (up to several files per entity). */
async function fetchWikidataImagesBatch(
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, WikiEntityLite>> {
  const out = new Map<string, WikiEntityLite>()
  const clean = [...new Set(ids.map((id) => id.toUpperCase()).filter((id) => /^Q\d+$/.test(id)))]
  for (let i = 0; i < clean.length; i += 20) {
    if (signal?.aborted) break
    const chunk = clean.slice(i, i + 20)
    try {
      const url = new URL('https://www.wikidata.org/w/api.php')
      url.searchParams.set('action', 'wbgetentities')
      url.searchParams.set('format', 'json')
      url.searchParams.set('origin', '*')
      url.searchParams.set('props', 'labels|descriptions|claims')
      url.searchParams.set('languages', 'en')
      url.searchParams.set('ids', chunk.join('|'))
      const res = await fetch(url.toString(), { signal })
      if (!res.ok) continue
      const json = (await res.json()) as {
        entities?: Record<
          string,
          {
            id: string
            labels?: { en?: { value: string } }
            descriptions?: { en?: { value: string } }
            claims?: {
              P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }>
            }
          }
        >
      }
      for (const entity of Object.values(json.entities ?? {})) {
        if (!entity?.id || entity.id.startsWith('-')) continue
        const images: string[] = []
        for (const claim of entity.claims?.P18 ?? []) {
          const file = claim.mainsnak?.datavalue?.value
          if (file) pushImage(images, `File:${file}`)
        }
        out.set(entity.id, {
          id: entity.id,
          summary: entity.descriptions?.en?.value || entity.labels?.en?.value || '',
          images: images.slice(0, 5),
        })
      }
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }
  return out
}

async function fetchCommonsCategoryImages(
  categoryTitle: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const url = new URL('https://commons.wikimedia.org/w/api.php')
    url.searchParams.set('action', 'query')
    url.searchParams.set('format', 'json')
    url.searchParams.set('origin', '*')
    url.searchParams.set('generator', 'categorymembers')
    url.searchParams.set('gcmtitle', categoryTitle)
    url.searchParams.set('gcmtype', 'file')
    url.searchParams.set('gcmlimit', '4')
    url.searchParams.set('prop', 'imageinfo')
    url.searchParams.set('iiprop', 'url')
    url.searchParams.set('iiurlwidth', '640')
    const res = await fetch(url.toString(), { signal })
    if (!res.ok) return []
    const json = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          { imageinfo?: Array<{ thumburl?: string; url?: string }> }
        >
      }
    }
    const images: string[] = []
    for (const page of Object.values(json.query?.pages ?? {})) {
      const info = page.imageinfo?.[0]
      pushImage(images, info?.thumburl || info?.url)
    }
    return images
  } catch {
    return []
  }
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function namesLooselyMatch(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  const wa = new Set(na.split(' ').filter((w) => w.length > 2))
  const wb = nb.split(' ').filter((w) => w.length > 2)
  if (!wa.size || !wb.length) return false
  const hit = wb.filter((w) => wa.has(w)).length
  return hit >= Math.min(2, wb.length)
}

function mergeImages(existing: string[], extra: string[], max = 6): string[] {
  const out = [...existing]
  for (const u of extra) {
    if (u && !out.includes(u)) out.push(u)
    if (out.length >= max) break
  }
  return out
}

/**
 * Enrich only with media clearly tied to the place:
 * OSM image / File tags, Commons categories that name-match the place, Wikidata P18.
 * Never invent nearby Wikipedia / name-search photos or copy their summaries.
 */
async function enrichImages(
  places: ExplorePlace[],
  signal?: AbortSignal,
): Promise<ExplorePlace[]> {
  const out = places.map((p) => ({ ...p, images: [...p.images] }))

  // 1) Commons categories tagged on OSM — only when the category looks like this place
  const withCat = out
    .map((p, idx) => ({ p, idx, cat: commonsCategoryTitle(p.tags) }))
    .filter(
      (x) =>
        x.cat &&
        x.p.images.length < 2 &&
        namesLooselyMatch(x.cat.replace(/^Category:/i, ''), x.p.name),
    )
    .slice(0, 12)
  for (const row of withCat) {
    if (signal?.aborted) break
    const imgs = await fetchCommonsCategoryImages(row.cat, signal)
    if (imgs.length) {
      out[row.idx] = {
        ...out[row.idx]!,
        images: mergeImages(out[row.idx]!.images, imgs.slice(0, 3)),
      }
    }
  }

  // 2) Batch Wikidata P18 + short description for places that have their own Q-id
  const wikiIds = out.map((p) => p.wikidata).filter(Boolean)
  const wikiMap = await fetchWikidataImagesBatch(wikiIds, signal)
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!
    if (!cur.wikidata) continue
    const wiki = wikiMap.get(cur.wikidata.toUpperCase())
    if (!wiki) continue
    out[i] = {
      ...cur,
      summary: cur.summary || clampText(wiki.summary, 400),
      images: mergeImages(cur.images, wiki.images),
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
    /** When set, use Places Nearby (1 Pro call) instead of Overpass. */
    googleApiKey?: string
    /** Fired immediately when a 2-day area cache hit exists (before network). */
    onCacheHit?: (places: ExplorePlace[]) => void
    /** After a cache hit, still refresh in the background (default true). */
    refreshInBackground?: boolean
  },
): Promise<ExplorePlace[]> {
  if (!isValidCoord(anchor.lat, anchor.lon)) return []
  const radiusM = opts?.radiusM ?? DEFAULT_RADIUS_M
  const useGoogle = Boolean(opts?.googleApiKey?.trim())
  const source = useGoogle ? 'google' : 'osm'
  // Google Nearby hard-caps at 20 — don't request / cache more than that
  const limit = useGoogle
    ? Math.min(opts?.limit ?? GOOGLE_NEARBY_MAX, GOOGLE_NEARBY_MAX)
    : (opts?.limit ?? DEFAULT_LIMIT)
  const key = cacheKey(anchor.lat, anchor.lon, radiusM, source)

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
      let list = withDistances(cached)
      if (useGoogle && opts?.googleApiKey) {
        list = attachGoogleListPhotos(
          list.map((p) =>
            p.tags.googlePhotoName ? { ...p, images: [] as string[] } : p,
          ),
          opts.googleApiKey,
        )
      }
      cacheHit = list
      opts?.onCacheHit?.(cacheHit)
      if (opts?.refreshInBackground === false) return cacheHit
    }
  }

  try {
    if (useGoogle) {
      const gKey = opts?.googleApiKey?.trim() || ''
      const places = await fetchGoogleNearbyViaProxy(anchor, {
        apiKey: gKey,
        radiusM,
        maxResultCount: limit,
        signal: opts?.signal,
      })
      if (opts?.signal?.aborted) return cacheHit ?? []
      const withPhotos = attachGoogleListPhotos(places, gKey)
      const fresh = withDistances(withPhotos)
      void setCached(key, fresh)
      return fresh
    }

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
