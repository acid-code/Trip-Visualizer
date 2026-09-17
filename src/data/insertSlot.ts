import type { TripItem } from '../domain/types'
import { isPlaceholderBase } from './dayBases'
import { requireIsoDate, sanitizeTime, todayIso } from './validate'

function parseMins(t?: string): number | null {
  const s = sanitizeTime(t)
  if (!s || !/^\d{2}:\d{2}$/.test(s)) return null
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

function formatMins(total: number): string {
  const mins = ((Math.round(total) % (24 * 60)) + 24 * 60) % (24 * 60)
  const hh = String(Math.floor(mins / 60)).padStart(2, '0')
  const mm = String(mins % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

function midpointTime(a?: string, b?: string): string {
  const am = parseMins(a)
  const bm = parseMins(b)
  if (am == null && bm == null) return ''
  if (am == null) return sanitizeTime(b)
  if (bm == null) return sanitizeTime(a)
  return formatMins(Math.round((am + bm) / 2))
}

/**
 * Sensible date/time when inserting between two timeline neighbors.
 * Cross-day passage → morning of the next day (not leftover midday on the left day).
 */
export function suggestInsertSlot(
  after: TripItem | null | undefined,
  before: TripItem | null | undefined,
  fallbackDate: string,
): { date: string; start: string } {
  const fallback = requireIsoDate(fallbackDate, todayIso())
  const afterReal = after && !isPlaceholderBase(after) ? after : null
  const beforeReal = before && !isPlaceholderBase(before) ? before : null

  const afterDate = after?.date
  const beforeDate = before?.date

  // Between two different calendar days (the dotted Day N → Day N+1 control)
  if (afterDate && beforeDate && afterDate !== beforeDate) {
    const date = requireIsoDate(beforeDate, fallback)
    const rightStart = parseMins(beforeReal?.start)
    if (rightStart != null && rightStart > 7 * 60) {
      // Sit just before the first real stop on the arriving day
      return {
        date,
        start: formatMins(Math.max(7 * 60, rightStart - 45)),
      }
    }
    return { date, start: '09:00' }
  }

  const date = requireIsoDate(
    afterReal?.date || beforeReal?.date || afterDate || beforeDate || fallback,
    fallback,
  )

  // Same day (or only one neighbor): midpoint between anchors
  const start = midpointTime(
    afterReal?.end || afterReal?.start,
    beforeReal?.start,
  )
  return { date, start }
}
