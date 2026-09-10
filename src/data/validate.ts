/** Shared input sanitizers — keep NaN / empty / bad dates out of trip state. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function isIsoDate(value: string | null | undefined): boolean {
  if (!value || !ISO_DATE.test(value)) return false
  const d = new Date(value + 'T12:00:00')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function sanitizeIsoDate(
  value: string | null | undefined,
  fallback = '',
): string {
  const v = String(value ?? '').trim()
  return isIsoDate(v) ? v : fallback
}

/** Prefer value if valid ISO; otherwise fallback; otherwise today. */
export function requireIsoDate(
  value: string | null | undefined,
  fallback?: string,
): string {
  const v = sanitizeIsoDate(value)
  if (v) return v
  const f = sanitizeIsoDate(fallback)
  if (f) return f
  return todayIso()
}

export function sanitizeTime(value: string | null | undefined): string {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (!TIME_HM.test(v)) return ''
  const [h, m] = v.split(':')
  return `${h!.padStart(2, '0')}:${m}`
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === '' || value == null) return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function parseNonNegativeNumber(value: unknown): number | null {
  const n = parseOptionalNumber(value)
  if (n == null) return null
  return n < 0 ? null : n
}

export function parseLat(value: unknown): number | null {
  const n = parseOptionalNumber(value)
  if (n == null || n < -90 || n > 90) return null
  return n
}

export function parseLon(value: unknown): number | null {
  const n = parseOptionalNumber(value)
  if (n == null || n < -180 || n > 180) return null
  return n
}

export function isValidCoord(lat: number | null | undefined, lon: number | null | undefined): boolean {
  return (
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  )
}

export function sanitizeTitle(value: string | null | undefined, fallback = 'Untitled'): string {
  const t = String(value ?? '').trim()
  return t || fallback
}

/** Ensure end >= start when both are ISO dates; otherwise clear end. */
export function sanitizeEndDate(start: string, end: string): string {
  if (!isIsoDate(end)) return ''
  if (isIsoDate(start) && end < start) return start
  return end
}

export function sanitizeMetaDates(startDate: string, endDate: string): {
  startDate: string
  endDate: string
} {
  const start = requireIsoDate(startDate)
  let end = sanitizeIsoDate(endDate, start)
  if (end < start) end = start
  return { startDate: start, endDate: end }
}

export type AddStepDraft = {
  type: string
  title: string
  date: string
  endDate?: string
  start?: string
  end?: string
  place?: string
  city?: string
  from?: string
  to?: string
  cost?: string
  currency?: string
  notes?: string
  isLeg?: boolean
  isHotel?: boolean
}

export type AddStepErrors = Partial<
  Record<'title' | 'date' | 'endDate' | 'start' | 'end' | 'cost' | 'from' | 'to', string>
>

export function validateAddStep(draft: AddStepDraft): {
  ok: boolean
  errors: AddStepErrors
} {
  const errors: AddStepErrors = {}
  if (!draft.title.trim()) errors.title = 'Name is required'
  if (!isIsoDate(draft.date)) errors.date = 'Pick a valid date'

  if (draft.endDate) {
    if (!isIsoDate(draft.endDate)) errors.endDate = 'Invalid end date'
    else if (isIsoDate(draft.date) && draft.endDate < draft.date) {
      errors.endDate = 'End date must be on or after start date'
    }
  }

  if (draft.start && !TIME_HM.test(draft.start.trim())) {
    errors.start = 'Use HH:MM'
  }
  if (draft.end && !TIME_HM.test(draft.end.trim())) {
    errors.end = 'Use HH:MM'
  }

  if (draft.cost != null && draft.cost.trim() !== '') {
    const n = parseNonNegativeNumber(draft.cost)
    if (n == null) errors.cost = 'Enter a valid amount (≥ 0)'
  }

  if (draft.isLeg) {
    if (!draft.from?.trim() && !draft.to?.trim()) {
      errors.from = 'Add From and/or To so we can place it on the map'
    }
  }

  return { ok: Object.keys(errors).length === 0, errors }
}
