/**
 * Email normalization for invite allowlists (Google Auth email matching).
 */

export function normalizeEmail(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/** Firestore doc id for invite paths — normalized email (allowed in doc ids). */
export function emailDocKey(raw: string): string {
  return normalizeEmail(raw)
}

export function isValidInviteEmail(raw: string): boolean {
  const email = normalizeEmail(raw)
  // Practical allowlist shape — must look like an email Google can verify.
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)
}
