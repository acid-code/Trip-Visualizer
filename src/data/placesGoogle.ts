/**
 * Google Places API (New) — Nearby Search for Explore.
 * Cost strategy: one Nearby Search (Pro) per fresh area; photos only when needed;
 * 2-day IndexedDB cache avoids repeat calls.
 */

import { distKm } from './routes'
import { clampText, logClientError, safeHttpsUrl, sanitizeSecretInput } from './security'
import { isValidCoord } from './validate'
import type { ExploreCategory, ExplorePlace } from './explore'

const PLACES_NEARBY = 'https://places.googleapis.com/v1/places:searchNearby'
const PLACES_TEXT = 'https://places.googleapis.com/v1/places:searchText'

/** Max Google returns per Nearby Search (API hard limit). One call = one Pro SKU. */
export const GOOGLE_NEARBY_MAX = 20

/** How many list-card photos to resolve (each media URL load ≈ 1 Photo SKU). */
export const GOOGLE_LIST_PHOTO_BUDGET = 6

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.websiteUri',
  'places.googleMapsUri',
].join(',')

/** Types we care about — one request covers food / drink / sights / nature. */
const INCLUDED_TYPES = [
  'restaurant',
  'cafe',
  'bakery',
  'bar',
  'museum',
  'art_gallery',
  'tourist_attraction',
  'park',
  'historical_landmark',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
  'zoo',
  'amusement_park',
  'aquarium',
  'lodging',
]

type GooglePlace = {
  id?: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  types?: string[]
  primaryType?: string
  formattedAddress?: string
  rating?: number
  userRatingCount?: number
  photos?: Array<{ name?: string }>
  websiteUri?: string
  googleMapsUri?: string
}

function categoryFromTypes(primary: string, types: string[]): ExploreCategory {
  const all = [primary, ...types].map((t) => t.toLowerCase())
  const has = (t: string) => all.includes(t)
  if (
    has('restaurant') ||
    has('cafe') ||
    has('bakery') ||
    has('meal_takeaway') ||
    has('meal_delivery') ||
    has('food')
  ) {
    return 'food'
  }
  if (has('bar') || has('night_club') || has('pub')) return 'drink'
  if (
    has('park') ||
    has('campground') ||
    has('national_park') ||
    has('natural_feature')
  ) {
    return 'nature'
  }
  if (
    has('museum') ||
    has('art_gallery') ||
    has('tourist_attraction') ||
    has('historical_landmark') ||
    has('church') ||
    has('hindu_temple') ||
    has('mosque') ||
    has('synagogue') ||
    has('zoo') ||
    has('aquarium') ||
    has('amusement_park')
  ) {
    return 'sights'
  }
  return 'other'
}

/** Place Photos media URL — loading it in <img> counts as a Photo SKU. */
export function googlePlacePhotoMediaUrl(
  photoName: string,
  apiKey: string,
  maxWidthPx = 640,
): string {
  const name = photoName.replace(/^\//, '')
  if (!name.startsWith('places/')) return ''
  const key = sanitizeSecretInput(apiKey)
  if (!key) return ''
  return `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(key)}`
}

export function hydrateGooglePlacePhoto(
  place: ExplorePlace,
  apiKey: string,
): ExplorePlace {
  if (place.images.length) return place
  const photoName = place.tags.googlePhotoName
  if (!photoName) return place
  const url = googlePlacePhotoMediaUrl(photoName, apiKey)
  if (!url) return place
  return { ...place, images: [url] }
}

/** Attach media URLs for the first N places that have a Google photo name. */
export function attachGoogleListPhotos(
  places: ExplorePlace[],
  apiKey: string,
  budget = GOOGLE_LIST_PHOTO_BUDGET,
): ExplorePlace[] {
  let used = 0
  return places.map((p) => {
    if (used >= budget) return p
    if (p.images.length || !p.tags.googlePhotoName) return p
    const url = googlePlacePhotoMediaUrl(p.tags.googlePhotoName, apiKey)
    if (!url) return p
    used += 1
    return { ...p, images: [url] }
  })
}

function googlePlaceToExplore(
  gp: GooglePlace,
  anchor: { lat: number; lon: number },
): ExplorePlace | null {
  const lat = gp.location?.latitude
  const lon = gp.location?.longitude
  if (!isValidCoord(lat, lon)) return null
  const name = clampText(gp.displayName?.text || '', 120)
  if (!name) return null
  const placeId = clampText(gp.id || '', 128)
  if (!placeId) return null
  const types = gp.types || []
  const primary = gp.primaryType || types[0] || ''
  const photoName = gp.photos?.[0]?.name || ''
  const mapsUri = safeHttpsUrl(gp.googleMapsUri || '')
  const rating =
    typeof gp.rating === 'number' && Number.isFinite(gp.rating)
      ? Math.round(gp.rating * 10) / 10
      : null

  return {
    id: `google:${placeId}`,
    name,
    lat: lat!,
    lon: lon!,
    category: categoryFromTypes(primary, types),
    osmType: 'google',
    osmId: placeId,
    wikidata: '',
    images: [],
    summary:
      typeof gp.userRatingCount === 'number' && gp.userRatingCount > 0
        ? clampText(`${gp.userRatingCount} Google reviews`, 80)
        : '',
    distKm: distKm(anchor, { lat: lat!, lon: lon! }),
    rating,
    cuisine: '',
    website: safeHttpsUrl(gp.websiteUri || ''),
    menuUrl: '',
    openingHours: '',
    address: clampText(gp.formattedAddress || '', 200),
    tags: {
      source: 'google',
      primaryType: primary,
      ...(photoName ? { googlePhotoName: photoName } : {}),
      ...(mapsUri ? { googleMapsUri: mapsUri } : {}),
    },
  }
}

/**
 * One Nearby Search (New) call — Pro SKU when rating is requested.
 * Prefer calling via `/api/places-nearby` to avoid browser CORS.
 */
export async function searchNearbyPlacesGoogle(opts: {
  lat: number
  lon: number
  radiusM: number
  apiKey: string
  maxResultCount?: number
  signal?: AbortSignal
}): Promise<ExplorePlace[]> {
  const apiKey = sanitizeSecretInput(opts.apiKey)
  if (!apiKey) throw new Error('Missing Google Maps API key')
  if (!isValidCoord(opts.lat, opts.lon)) return []

  const radius = Math.min(Math.max(opts.radiusM, 50), 50000)
  const maxResultCount = Math.min(
    Math.max(opts.maxResultCount ?? GOOGLE_NEARBY_MAX, 1),
    GOOGLE_NEARBY_MAX,
  )

  const res = await fetch(PLACES_NEARBY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      languageCode: 'en',
      includedTypes: INCLUDED_TYPES,
      maxResultCount,
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: { latitude: opts.lat, longitude: opts.lon },
          radius,
        },
      },
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logClientError('places-nearby', new Error(`${res.status} ${text.slice(0, 200)}`))
    throw new Error(`Places Nearby ${res.status}`)
  }

  const json = (await res.json()) as { places?: GooglePlace[] }
  const out: ExplorePlace[] = []
  const seen = new Set<string>()
  for (const gp of json.places ?? []) {
    const place = googlePlaceToExplore(gp, { lat: opts.lat, lon: opts.lon })
    if (!place || seen.has(place.id)) continue
    seen.add(place.id)
    out.push(place)
  }
  out.sort((a, b) => a.distKm - b.distKm)
  return out
}

/** Client → same-origin proxy (avoids CORS). */
export async function fetchGoogleNearbyViaProxy(
  anchor: { lat: number; lon: number },
  opts: {
    apiKey: string
    radiusM?: number
    maxResultCount?: number
    signal?: AbortSignal
  },
): Promise<ExplorePlace[]> {
  const res = await fetch('/api/places-nearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      lat: anchor.lat,
      lon: anchor.lon,
      radiusM: opts.radiusM ?? 1500,
      maxResultCount: opts.maxResultCount ?? GOOGLE_NEARBY_MAX,
      apiKey: sanitizeSecretInput(opts.apiKey),
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errBody?.error || `Places proxy ${res.status}`)
  }
  const json = (await res.json()) as { places?: ExplorePlace[] }
  return json.places ?? []
}

export type GoogleTextHit = {
  lat: number
  lon: number
  name: string
  address: string
  placeId: string
}

const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.formattedAddress',
].join(',')

/**
 * One Text Search (New) call — take the top hit for pin drop.
 * Essentials-only field mask (no rating/photos) keeps the SKU as lean as Text Search allows.
 */
export async function searchTextPlaceGoogle(opts: {
  query: string
  apiKey: string
  bias?: { lat: number; lon: number; radiusM?: number }
  signal?: AbortSignal
}): Promise<GoogleTextHit | null> {
  const apiKey = sanitizeSecretInput(opts.apiKey)
  const textQuery = clampText(opts.query, 200)
  if (!apiKey || !textQuery) return null

  const body: Record<string, unknown> = {
    textQuery,
    languageCode: 'en',
    pageSize: 1,
    maxResultCount: 1,
  }
  if (opts.bias && isValidCoord(opts.bias.lat, opts.bias.lon)) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.bias.lat, longitude: opts.bias.lon },
        radius: Math.min(Math.max(opts.bias.radiusM ?? 50_000, 100), 50_000),
      },
    }
  }

  const res = await fetch(PLACES_TEXT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': TEXT_FIELD_MASK,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logClientError('places-text', new Error(`${res.status} ${text.slice(0, 200)}`))
    throw new Error(`Places Text ${res.status}`)
  }

  const json = (await res.json()) as { places?: GooglePlace[] }
  const gp = json.places?.[0]
  if (!gp) return null
  const lat = gp.location?.latitude
  const lon = gp.location?.longitude
  if (!isValidCoord(lat, lon)) return null
  const name = clampText(gp.displayName?.text || '', 120)
  if (!name) return null
  return {
    lat: lat!,
    lon: lon!,
    name,
    address: clampText(gp.formattedAddress || '', 200),
    placeId: clampText(gp.id || '', 128),
  }
}

export async function fetchGoogleTextViaProxy(opts: {
  query: string
  apiKey: string
  bias?: { lat: number; lon: number; radiusM?: number }
  signal?: AbortSignal
}): Promise<GoogleTextHit | null> {
  const res = await fetch('/api/places-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: opts.query,
      apiKey: sanitizeSecretInput(opts.apiKey),
      bias: opts.bias,
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(errBody?.error || `Places text proxy ${res.status}`)
  }
  const json = (await res.json()) as { place?: GoogleTextHit | null }
  return json.place ?? null
}
