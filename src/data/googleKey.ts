/** Google Maps / Places key resolution: Data override → Vercel/env default → none. */

import { sanitizeSecretInput } from './security'

/** Build-time default from Vercel / `.env` (`VITE_GOOGLE_MAPS_API_KEY`). */
export function envGoogleMapsApiKey(): string {
  return sanitizeSecretInput(String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? ''))
}

/**
 * Effective key for Map Tiles / Places.
 * Non-empty Data override wins; empty override falls back to the deploy env default.
 */
export function resolveGoogleMapsApiKey(overrideFromData: string | null | undefined): string {
  const override = sanitizeSecretInput(overrideFromData ?? '')
  if (override) return override
  return envGoogleMapsApiKey()
}

export function hasEnvGoogleMapsApiKey(): boolean {
  return envGoogleMapsApiKey().length > 0
}
