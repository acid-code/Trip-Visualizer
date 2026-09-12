/** Shared Google Maps env resolution for Vercel/API routes (never expose to the client). */

export function serverGoogleMapsApiKey(bodyKey?: unknown): string {
  const fromBody = String(bodyKey ?? '').trim()
  if (fromBody.startsWith('AIza')) return fromBody
  return String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim()
}

export function serverPlacesConfigured(): boolean {
  const key = String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim()
  return key.startsWith('AIza')
}
