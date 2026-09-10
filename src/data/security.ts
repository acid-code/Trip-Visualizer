/**
 * Client-side security helpers aligned with OWASP WSTG practices
 * for this local-first SPA (no multi-tenant backend).
 */

const SECRET_HINT =
  /(?:api[_-]?key|token|secret|password|authorization|bearer|eyJ[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{10,})/i

/** Setting keys the UI may write — deny everything else (allowlist). */
export const ALLOWED_SETTING_KEYS = [
  'googleMapsKey',
  'cesiumIonToken',
  'mapStack',
] as const

export type AllowedSettingKey = (typeof ALLOWED_SETTING_KEYS)[number]

export function isAllowedSettingKey(key: string): key is AllowedSettingKey {
  return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key)
}

/** Trim + length-cap secrets; reject control characters. */
export function sanitizeSecretInput(raw: string, maxLen = 512): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen)
}

/** Only allow https: (or empty). Blocks javascript:/data: XSS vectors in img/href. */
export function safeHttpsUrl(raw: string | null | undefined, maxLen = 2048): string {
  const s = String(raw ?? '').trim().slice(0, maxLen)
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return ''
    return u.toString()
  } catch {
    return ''
  }
}

/** Safe entity / trip ids for Cesium (no HTML/script payload in descriptions). */
export function sanitizeEntityId(raw: string, maxLen = 64): string {
  const cleaned = String(raw ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, maxLen)
  return cleaned || 'X'
}

export function clampText(raw: unknown, maxLen: number, fallback = ''): string {
  const s = String(raw ?? '')
    .replace(/\u0000/g, '')
    .trim()
  if (!s) return fallback
  return s.slice(0, maxLen)
}

/**
 * User-facing errors must stay generic (WSTG-ERRH).
 * Never surface stack traces, paths, or raw parser internals.
 */
export function publicErrorMessage(
  _err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  return fallback
}

/** Dev/console logging only — strip tokens / key-like substrings. */
export function logClientError(context: string, err: unknown): void {
  if (!import.meta.env.DEV) return
  const msg =
    err instanceof Error
      ? redactSecrets(err.message)
      : redactSecrets(String(err))
  console.error(`[${context}]`, msg)
}

function redactSecrets(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (SECRET_HINT.test(part) ? '[redacted]' : part))
    .join('')
    .slice(0, 500)
}

/** Excel / import size limits (DoS / memory). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_SCHEDULE_ROWS = 2000
export const MAX_GEOCODE_QUERY_LEN = 300
