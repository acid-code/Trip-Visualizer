/**
 * Google Places API (New) — Nearby Search for Explore.
 * Cost strategy: one Nearby Search (Pro) per fresh area; photos only when needed;
 * 2-day IndexedDB cache avoids repeat calls.
 */

import { distKm } from './routes'
import { clampText, logClientError, safeHttpsUrl, sanitizeSecretInput } from './security'
import { isValidCoord } from './validate'
import type { ExploreCategory, ExplorePlace } from './explore'
import {
  periodsFromGoogleRegularHours,
  weekdayTextFromGoogle,
} from './openingHours'

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
  'places.regularOpeningHours',
  'places.editorialSummary',
  'places.generativeSummary',
].join(',')

/** Broad mix — Journey Explore (client filters by chip). */
const INCLUDED_TYPES_ALL = [
  'restaurant',
  'cafe',
  'bakery',
  'bar',
  'winery',
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
  'movie_theater',
  'bowling_alley',
  'spa',
  'stadium',
  'adventure_sports_center',
  'water_park',
  'beach',
  'marina',
  'lodging',
]

/** Per-category types so Nearby's 20-result cap isn't eaten by restaurants. */
const INCLUDED_TYPES_BY_CATEGORY: Record<ExploreCategory, string[]> = {
  food: ['restaurant', 'cafe', 'bakery'],
  drink: ['bar', 'winery', 'night_club', 'pub'],
  sights: [
    'museum',
    'art_gallery',
    'tourist_attraction',
    'historical_landmark',
    'church',
    'hindu_temple',
    'mosque',
    'synagogue',
    'visitor_center',
  ],
  activity: [
    'amusement_park',
    'aquarium',
    'zoo',
    'movie_theater',
    'bowling_alley',
    'spa',
    'stadium',
    'adventure_sports_center',
    'water_park',
    'casino',
    'performing_arts_theater',
    'ferris_wheel',
    'go_karting_venue',
    'miniature_golf_course',
    'paintball_center',
    'skateboard_park',
    'video_arcade',
    'comedy_club',
    'karaoke',
    'concert_hall',
  ],
  hotel: ['lodging'],
  nature: ['park', 'beach', 'marina', 'campground', 'national_park'],
  other: INCLUDED_TYPES_ALL,
}

/** Resolve Google `includedTypes` for an optional category filter.
 *  Returns `null` when the caller wants no type restriction (all Table A places). */
export function includedTypesForCategories(
  categories?: ExploreCategory[],
  unrestricted?: boolean,
): string[] | null {
  if (unrestricted) return null
  if (!categories?.length) return INCLUDED_TYPES_ALL
  const seen = new Set<string>()
  const out: string[] = []
  for (const cat of categories) {
    for (const t of INCLUDED_TYPES_BY_CATEGORY[cat] ?? []) {
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out.length ? out : INCLUDED_TYPES_ALL
}

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
  regularOpeningHours?: unknown
  editorialSummary?: { text?: string }
  generativeSummary?: {
    overview?: { text?: string }
    description?: { text?: string }
  }
}

function categoryFromTypes(primary: string, types: string[]): ExploreCategory {
  const p = (primary || '').toLowerCase()
  const all = [p, ...types.map((t) => t.toLowerCase())].filter(Boolean)
  const has = (t: string) => all.includes(t)

  const isLodgingType = (t: string) =>
    t === 'lodging' ||
    t === 'hotel' ||
    t === 'motel' ||
    t === 'resort_hotel' ||
    t === 'extended_stay_hotel' ||
    t === 'guest_house' ||
    t === 'hostel'

  const isFoodType = (t: string) =>
    t === 'restaurant' ||
    t === 'cafe' ||
    t === 'bakery' ||
    t === 'meal_takeaway' ||
    t === 'meal_delivery' ||
    t === 'food'

  const isDrinkType = (t: string) =>
    t === 'bar' || t === 'night_club' || t === 'pub' || t === 'winery'

  // Prefer primaryType — hotel restaurants often also list lodging
  if (p && isFoodType(p)) return 'food'
  if (p && isDrinkType(p)) return 'drink'
  if (p && isLodgingType(p)) return 'hotel'

  // Both food + lodging in secondary types → dining (not a new hotel stay)
  if (all.some(isFoodType) && all.some(isLodgingType)) return 'food'
  if (all.some(isDrinkType) && all.some(isLodgingType)) return 'drink'
  if (all.some(isLodgingType)) return 'hotel'
  if (all.some(isFoodType)) return 'food'
  if (all.some(isDrinkType)) return 'drink'
  if (has('vineyard')) return 'drink'
  if (
    has('amusement_park') ||
    has('aquarium') ||
    has('zoo') ||
    has('movie_theater') ||
    has('bowling_alley') ||
    has('spa') ||
    has('stadium') ||
    has('adventure_sports_center') ||
    has('water_park') ||
    has('casino') ||
    has('performing_arts_theater') ||
    has('ferris_wheel') ||
    has('go_karting_venue') ||
    has('miniature_golf_course') ||
    has('paintball_center') ||
    has('skateboard_park') ||
    has('video_arcade') ||
    has('comedy_club') ||
    has('karaoke') ||
    has('concert_hall')
  ) {
    return 'activity'
  }
  if (
    has('park') ||
    has('campground') ||
    has('national_park') ||
    has('natural_feature') ||
    has('beach') ||
    has('marina')
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
    has('visitor_center')
  ) {
    return 'sights'
  }
  return 'other'
}

/**
 * Place Photos media URL — loading it in <img> counts as a Photo SKU.
 * With a Data-panel key → Google URL; otherwise → same-origin proxy (server key).
 */
export function googlePlacePhotoMediaUrl(
  photoName: string,
  apiKey?: string,
  maxWidthPx = 640,
): string {
  const name = photoName.replace(/^\//, '')
  if (!name.startsWith('places/')) return ''
  const key = sanitizeSecretInput(apiKey ?? '')
  if (key) {
    return `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(key)}`
  }
  return `/api/places-photo?name=${encodeURIComponent(name)}&maxWidthPx=${maxWidthPx}`
}

export function hydrateGooglePlacePhoto(
  place: ExplorePlace,
  apiKey?: string,
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
  apiKey?: string,
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
  const openingPeriods = periodsFromGoogleRegularHours(gp.regularOpeningHours)
  const openingHours =
    weekdayTextFromGoogle(gp.regularOpeningHours) ||
    (openingPeriods.length ? 'Hours on file' : '')
  const editorial = clampText(gp.editorialSummary?.text || '', 500)
  const generative = clampText(
    gp.generativeSummary?.overview?.text ||
      gp.generativeSummary?.description?.text ||
      '',
    500,
  )
  const reviewBlurb =
    typeof gp.userRatingCount === 'number' && gp.userRatingCount > 0
      ? clampText(`${gp.userRatingCount} Google reviews`, 80)
      : ''

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
    summary: editorial || generative || reviewBlurb,
    distKm: distKm(anchor, { lat: lat!, lon: lon! }),
    rating,
    cuisine: '',
    website: safeHttpsUrl(gp.websiteUri || ''),
    menuUrl: '',
    openingHours,
    openingPeriods: openingPeriods.length ? openingPeriods : undefined,
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
  categories?: ExploreCategory[]
  /** Omit includedTypes — return any nearby place type. */
  unrestricted?: boolean
  rankPreference?: 'DISTANCE' | 'POPULARITY'
}): Promise<ExplorePlace[]> {
  const apiKey = sanitizeSecretInput(opts.apiKey)
  if (!apiKey) throw new Error('Missing Google Maps API key')
  if (!isValidCoord(opts.lat, opts.lon)) return []

  const radius = Math.min(Math.max(opts.radiusM, 50), 50000)
  const maxResultCount = Math.min(
    Math.max(opts.maxResultCount ?? GOOGLE_NEARBY_MAX, 1),
    GOOGLE_NEARBY_MAX,
  )
  const includedTypes = includedTypesForCategories(
    opts.categories,
    opts.unrestricted,
  )
  const rankPreference = opts.rankPreference === 'POPULARITY' ? 'POPULARITY' : 'DISTANCE'

  const res = await fetch(PLACES_NEARBY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      languageCode: 'en',
      ...(includedTypes ? { includedTypes } : {}),
      maxResultCount,
      rankPreference,
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

/** Client → same-origin proxy (avoids CORS). Server key used when `apiKey` omitted. */
export async function fetchGoogleNearbyViaProxy(
  anchor: { lat: number; lon: number },
  opts: {
    apiKey?: string
    radiusM?: number
    maxResultCount?: number
    signal?: AbortSignal
    categories?: ExploreCategory[]
    unrestricted?: boolean
    rankPreference?: 'DISTANCE' | 'POPULARITY'
  },
): Promise<ExplorePlace[]> {
  const override = sanitizeSecretInput(opts.apiKey ?? '')
  const res = await fetch('/api/places-nearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      lat: anchor.lat,
      lon: anchor.lon,
      radiusM: opts.radiusM ?? 1500,
      maxResultCount: opts.maxResultCount ?? GOOGLE_NEARBY_MAX,
      rankPreference: opts.rankPreference === 'POPULARITY' ? 'POPULARITY' : 'DISTANCE',
      ...(opts.unrestricted
        ? { unrestricted: true }
        : opts.categories?.length
          ? { categories: opts.categories }
          : {}),
      ...(override ? { apiKey: override } : {}),
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null
    const msg = errBody?.error || `Places proxy ${res.status}`
    logClientError('places-nearby-proxy', msg)
    throw new Error(msg)
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
  category?: ExploreCategory
  primaryType?: string
  types?: string[]
  rating?: number | null
  userRatingCount?: number | null
  photoName?: string
  googleMapsUri?: string
  website?: string
  openingHours?: string
  openingPeriods?: import('./openingHours').OpeningPeriod[]
  /** Maps-style editorial / AI overview when Places returns it. */
  summary?: string
}

const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.formattedAddress',
  'places.types',
  'places.primaryType',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.regularOpeningHours',
  'places.editorialSummary',
  'places.generativeSummary',
].join(',')

/**
 * One Text Search (New) call — take the top hit for pin drop / Plan recommendation.
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
  const types = gp.types || []
  const primary = gp.primaryType || types[0] || ''
  const photoName = gp.photos?.[0]?.name || ''
  const rating =
    typeof gp.rating === 'number' && Number.isFinite(gp.rating)
      ? Math.round(gp.rating * 10) / 10
      : null
  const openingPeriods = periodsFromGoogleRegularHours(gp.regularOpeningHours)
  const openingHours =
    weekdayTextFromGoogle(gp.regularOpeningHours) ||
    (openingPeriods.length ? 'Hours on file' : '')
  const editorial = clampText(gp.editorialSummary?.text || '', 500)
  const generative = clampText(
    gp.generativeSummary?.overview?.text ||
      gp.generativeSummary?.description?.text ||
      '',
    500,
  )
  return {
    lat: lat!,
    lon: lon!,
    name,
    address: clampText(gp.formattedAddress || '', 200),
    placeId: clampText(gp.id || '', 128),
    category: categoryFromTypes(primary, types),
    primaryType: primary,
    types,
    rating,
    userRatingCount:
      typeof gp.userRatingCount === 'number' ? gp.userRatingCount : null,
    photoName,
    googleMapsUri: safeHttpsUrl(gp.googleMapsUri || ''),
    website: safeHttpsUrl(gp.websiteUri || ''),
    openingHours,
    openingPeriods: openingPeriods.length ? openingPeriods : undefined,
    summary: editorial || generative,
  }
}

/** Build an ExplorePlace from a Text Search hit (Plan recommendation → Nearby). */
export function explorePlaceFromTextHit(
  hit: GoogleTextHit,
  anchor?: { lat: number; lon: number },
  apiKey?: string,
): ExplorePlace {
  const cat = hit.category || 'other'
  const photoName = hit.photoName || ''
  let place: ExplorePlace = {
    id: hit.placeId ? `google:${hit.placeId}` : `search:${hit.lat.toFixed(5)},${hit.lon.toFixed(5)}`,
    name: hit.name,
    lat: hit.lat,
    lon: hit.lon,
    category: cat,
    osmType: hit.placeId ? 'google' : 'search',
    osmId: hit.placeId || '',
    wikidata: '',
    images: [],
    summary:
      hit.summary ||
      (hit.userRatingCount && hit.userRatingCount > 0
        ? clampText(`${hit.userRatingCount} Google reviews`, 80)
        : ''),
    distKm: anchor
      ? distKm(anchor, { lat: hit.lat, lon: hit.lon })
      : 0,
    rating: hit.rating ?? null,
    cuisine: '',
    website: hit.website || '',
    menuUrl: '',
    openingHours: hit.openingHours || '',
    openingPeriods: hit.openingPeriods,
    address: hit.address || '',
    tags: {
      source: hit.placeId ? 'google' : 'search',
      primaryType: hit.primaryType || '',
      ...(photoName ? { googlePhotoName: photoName } : {}),
      ...(hit.googleMapsUri ? { googleMapsUri: hit.googleMapsUri } : {}),
    },
  }
  if (photoName) {
    place = attachGoogleListPhotos([place], apiKey, 1)[0]!
  }
  return place
}

export async function fetchGoogleTextViaProxy(opts: {
  query: string
  /** Data-panel override only; omit to use server `GOOGLE_MAPS_API_KEY`. */
  apiKey?: string
  bias?: { lat: number; lon: number; radiusM?: number }
  signal?: AbortSignal
}): Promise<GoogleTextHit | null> {
  const override = sanitizeSecretInput(opts.apiKey ?? '')
  const res = await fetch('/api/places-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: opts.query,
      ...(override ? { apiKey: override } : {}),
      bias: opts.bias,
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null
    const msg = errBody?.error || `Places text proxy ${res.status}`
    logClientError('places-text-proxy', msg)
    throw new Error(msg)
  }
  const json = (await res.json()) as { place?: GoogleTextHit | null }
  const place = json.place ?? null
  if (!place) return null
  // Normalize older proxy payloads that lack category.
  if (!place.category && place.types?.length) {
    place.category = categoryFromTypes(place.primaryType || '', place.types)
  }
  return place
}
