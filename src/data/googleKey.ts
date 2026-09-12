/** Google Maps key: Data-panel override only (never bake VITE_ secrets into the client). */

import { sanitizeSecretInput } from './security'

/**
 * Effective client-side key (Map Tiles / optional photo URLs).
 * Deploy default lives server-side as `GOOGLE_MAPS_API_KEY` and is used via `/api/*`.
 */
export function resolveGoogleMapsApiKey(overrideFromData: string | null | undefined): string {
  return sanitizeSecretInput(overrideFromData ?? '')
}
