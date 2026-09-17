/**
 * Firestore rejects `undefined` anywhere in a document.
 * Convert TripRecord (and nested objects) into a plain JSON-safe payload.
 */
export function forFirestore<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (v === undefined ? undefined : v)),
  ) as T
}

/** User-facing share/sync errors — keep codes actionable, no stacks. */
export function shareErrorMessage(err: unknown, fallback: string): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : ''
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''

  if (code === 'permission-denied' || /permission/i.test(msg)) {
    return 'Permission denied — publish firestore.rules in Firebase Console (Firestore → Rules), then retry'
  }
  if (
    code === 'auth/internal-error' ||
    code === 'auth/unauthorized-domain' ||
    /auth\/internal-error|unauthorized.domain|auth\/unauthorized/i.test(msg)
  ) {
    return 'Google sign-in blocked — add this site’s hostname under Firebase Authentication → Settings → Authorized domains (and allow popups). Preview URLs need their own entry.'
  }
  if (code === 'auth/popup-blocked' || /popup.?blocked/i.test(msg)) {
    return 'Sign-in popup was blocked — allow popups for this site and try again'
  }
  if (code === 'auth/popup-closed-by-user' || /popup.?closed/i.test(msg)) {
    return 'Sign-in cancelled'
  }
  if (code === 'unavailable' || /offline|network/i.test(msg)) {
    return 'Network unavailable — check connection and try again'
  }
  if (
    code === 'invalid-argument' ||
    /unsupported field|undefined|nested array|Nested arrays/i.test(msg)
  ) {
    return 'Could not upload trip data — try again after refreshing'
  }
  if (/not configured|VITE_FIREBASE/i.test(msg)) {
    return msg
  }
  if (/PARTNER_UPDATED/.test(msg)) {
    return 'Someone else updated — reloaded cloud version (your last edit was not pushed)'
  }
  if (msg === 'SHARE_GONE' || code === 'SHARE_GONE') {
    return 'Shared trip is no longer available in the cloud'
  }
  if (msg && msg.length < 160 && !/firebase|stack|http/i.test(msg)) {
    return msg
  }
  return fallback
}
