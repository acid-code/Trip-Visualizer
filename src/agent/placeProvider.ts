/**
 * Session-scoped Google Places vs OSM provider.
 * Prefer Google when healthy; fall back to OSM on quota/key/error.
 */

import type { PlaceProvider } from './types'

let cached: { provider: PlaceProvider; at: number } | null = null
const CACHE_MS = 1000 * 60 * 10 // 10 minutes

export function getCachedPlaceProvider(): PlaceProvider | null {
  if (!cached) return null
  if (Date.now() - cached.at > CACHE_MS) {
    cached = null
    return null
  }
  return cached.provider
}

export function setPlaceProvider(provider: PlaceProvider): void {
  cached = { provider, at: Date.now() }
}

export function clearPlaceProviderCache(): void {
  cached = null
}

/** True when agent/tools should pass useGooglePlaces. */
export function useGooglePlacesNow(): boolean {
  return getCachedPlaceProvider() === 'google'
}

/**
 * Probe /api/maps-status. When placesConfigured is false, use OSM.
 * Optionally force OSM after a Places call failure (quota).
 */
export async function resolvePlaceProvider(opts?: {
  forceOsm?: boolean
  signal?: AbortSignal
}): Promise<PlaceProvider> {
  if (opts?.forceOsm) {
    setPlaceProvider('osm')
    return 'osm'
  }
  const hit = getCachedPlaceProvider()
  if (hit) return hit

  try {
    const res = await fetch('/api/maps-status', {
      cache: 'no-store',
      signal: opts?.signal,
    })
    if (!res.ok) {
      setPlaceProvider('osm')
      return 'osm'
    }
    const data = (await res.json()) as { placesConfigured?: boolean }
    const provider: PlaceProvider = data.placesConfigured ? 'google' : 'osm'
    setPlaceProvider(provider)
    return provider
  } catch {
    setPlaceProvider('osm')
    return 'osm'
  }
}

/** Call after a Places nearby/text failure that looks like quota. */
export function markPlacesUnhealthy(reason?: string): void {
  const r = (reason || '').toLowerCase()
  if (
    /quota|resource.?exhausted|429|billing|daily.?limit|over.?quer/i.test(r) ||
    !reason
  ) {
    setPlaceProvider('osm')
  }
}

export function placeProviderLabel(provider: PlaceProvider): string {
  return provider === 'google'
    ? 'Google Places'
    : 'OpenStreetMap (Google Places unavailable)'
}
