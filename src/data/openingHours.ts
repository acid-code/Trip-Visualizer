/** Opening-hours checks for Explore / Day Coach (Google periods + OSM best-effort). */

export type OpeningClock = { day: number; hour: number; minute: number }

export type OpeningPeriod = {
  open: OpeningClock
  /** Missing close ≈ open 24h from open (Google 24h places). */
  close?: OpeningClock
}

export type OpenStatus = 'open' | 'closed' | 'unknown'

const DOW: Record<string, number> = {
  su: 0,
  sun: 0,
  sunday: 0,
  mo: 1,
  mon: 1,
  monday: 1,
  tu: 2,
  tue: 2,
  tues: 2,
  tuesday: 2,
  we: 3,
  wed: 3,
  wednesday: 3,
  th: 4,
  thu: 4,
  thur: 4,
  thursday: 4,
  fr: 5,
  fri: 5,
  friday: 5,
  sa: 6,
  sat: 6,
  saturday: 6,
}

function clampClock(raw: {
  day?: number
  hour?: number
  minute?: number
}): OpeningClock | null {
  const day = Number(raw.day)
  const hour = Number(raw.hour)
  const minute = Number(raw.minute ?? 0)
  if (!Number.isFinite(day) || day < 0 || day > 6) return null
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null
  return { day, hour, minute }
}

/** Normalize Google Places (New) regularOpeningHours.periods → OpeningPeriod[]. */
export function periodsFromGoogleRegularHours(raw: unknown): OpeningPeriod[] {
  if (!raw || typeof raw !== 'object') return []
  const periods = (raw as { periods?: unknown }).periods
  if (!Array.isArray(periods)) return []
  const out: OpeningPeriod[] = []
  for (const row of periods) {
    if (!row || typeof row !== 'object') continue
    const r = row as { open?: unknown; close?: unknown }
    if (!r.open || typeof r.open !== 'object') continue
    const open = clampClock(r.open as OpeningClock)
    if (!open) continue
    let close: OpeningClock | undefined
    if (r.close && typeof r.close === 'object') {
      close = clampClock(r.close as OpeningClock) || undefined
    }
    out.push({ open, close })
  }
  return out
}

export function weekdayTextFromGoogle(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const desc = (raw as { weekdayDescriptions?: unknown }).weekdayDescriptions
  if (!Array.isArray(desc)) return ''
  return desc
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .join('; ')
    .slice(0, 400)
}

function parseHm(hm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function dayOfIsoDate(dateISO: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
  const [y, mo, d] = dateISO.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, mo! - 1, d!))
  if (Number.isNaN(dt.getTime())) return null
  return dt.getUTCDay() // 0=Sun — matches Google Places
}

function absMin(day: number, minuteOfDay: number): number {
  return day * 1440 + minuteOfDay
}

function openViaPeriods(
  periods: OpeningPeriod[],
  day: number,
  minuteOfDay: number,
): boolean {
  const t0 = absMin(day, minuteOfDay)
  const candidates = [t0, t0 + 7 * 1440]
  for (const p of periods) {
    const openM = absMin(p.open.day, p.open.hour * 60 + p.open.minute)
    let closeM = p.close
      ? absMin(p.close.day, p.close.hour * 60 + p.close.minute)
      : openM + 24 * 60
    if (closeM <= openM) closeM += 7 * 1440
    for (const t of candidates) {
      if (t >= openM && t < closeM) return true
      if (t + 7 * 1440 >= openM && t + 7 * 1440 < closeM) return true
    }
  }
  return false
}

/** Expand Mo-Fr / Sa-Su / Mo,We style tokens into day numbers. */
function expandDayToken(tok: string): number[] {
  const t = tok.trim().toLowerCase()
  if (!t) return []
  if (t.includes('-')) {
    const [a, b] = t.split('-').map((x) => x.trim())
    const start = DOW[a!]
    const end = DOW[b!]
    if (start == null || end == null) return []
    const out: number[] = []
    let d = start
    for (let i = 0; i < 7; i++) {
      out.push(d)
      if (d === end) break
      d = (d + 1) % 7
    }
    return out
  }
  const one = DOW[t]
  return one == null ? [] : [one]
}

/**
 * Best-effort OSM `opening_hours` — handles 24/7 and simple Mo-Fr 09:00-18:00 forms.
 * Returns null when the string is too complex to trust.
 */
export function periodsFromOsmHours(raw: string): OpeningPeriod[] | null {
  const s = raw.trim()
  if (!s) return null
  if (/^24\/7$/i.test(s) || /^24 hours$/i.test(s)) {
    return Array.from({ length: 7 }, (_, day) => ({
      open: { day, hour: 0, minute: 0 },
      close: { day, hour: 23, minute: 59 },
    }))
  }
  // Reject rules we don't understand (PH, seasons, months, etc.)
  if (/PH|\[|month|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|sunrise|sunset|\+/i.test(s)) {
    return null
  }

  const periods: OpeningPeriod[] = []
  const chunks = s.split(';').map((c) => c.trim()).filter(Boolean)
  for (const chunk of chunks) {
    // "Mo-Fr 09:00-18:00" or "Mo,Tu,We 10:00-14:00,15:00-20:00"
    const m = /^([A-Za-z0-9,\-\s]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s*,\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?$/.exec(
      chunk,
    )
    if (!m) return null
    const days: number[] = []
    for (const part of m[1]!.split(',')) {
      days.push(...expandDayToken(part))
    }
    if (!days.length) return null
    const ranges: Array<[number, number]> = []
    const a = parseHm(m[2]!)
    const b = parseHm(m[3]!)
    if (a == null || b == null) return null
    ranges.push([a, b])
    if (m[4] && m[5]) {
      const c = parseHm(m[4])
      const d = parseHm(m[5])
      if (c == null || d == null) return null
      ranges.push([c, d])
    }
    for (const day of [...new Set(days)]) {
      for (const [start, end] of ranges) {
        const open = {
          day,
          hour: Math.floor(start / 60),
          minute: start % 60,
        }
        let closeDay = day
        let closeMin = end
        if (end <= start) {
          closeDay = (day + 1) % 7
        }
        periods.push({
          open,
          close: {
            day: closeDay,
            hour: Math.floor(closeMin / 60),
            minute: closeMin % 60,
          },
        })
      }
    }
  }
  return periods.length ? periods : null
}

export function resolveOpeningPeriods(args: {
  periods?: OpeningPeriod[] | null
  openingHours?: string | null
}): OpeningPeriod[] | null {
  if (args.periods?.length) return args.periods
  const osm = periodsFromOsmHours(String(args.openingHours || ''))
  return osm
}

export function placeOpenStatus(args: {
  dateISO: string
  timeHM: string
  periods?: OpeningPeriod[] | null
  openingHours?: string | null
}): OpenStatus {
  const day = dayOfIsoDate(args.dateISO)
  const minuteOfDay = parseHm(args.timeHM)
  if (day == null || minuteOfDay == null) return 'unknown'
  const periods = resolveOpeningPeriods(args)
  if (!periods?.length) {
    // "Closed" alone in text
    const text = String(args.openingHours || '').toLowerCase()
    if (text && /closed|off\b|nicht geöffnet/.test(text) && !/\d{1,2}:\d{2}/.test(text)) {
      return 'closed'
    }
    return 'unknown'
  }
  return openViaPeriods(periods, day, minuteOfDay) ? 'open' : 'closed'
}

/** True when we should keep a candidate for a suggested visit time. */
export function acceptPlaceForTime(args: {
  dateISO: string
  timeHM?: string | null
  periods?: OpeningPeriod[] | null
  openingHours?: string | null
}): boolean {
  const time = args.timeHM || '12:00'
  return placeOpenStatus({ ...args, timeHM: time }) !== 'closed'
}

export function summarizeOpenSlots(
  dateISO: string,
  periods: OpeningPeriod[] | null | undefined,
  openingHours: string | undefined,
  slots: string[] = ['09:00', '13:00', '16:00', '19:30', '21:00'],
): string {
  const known = slots.filter(
    (t) =>
      placeOpenStatus({
        dateISO,
        timeHM: t,
        periods,
        openingHours,
      }) === 'open',
  )
  const closed = slots.filter(
    (t) =>
      placeOpenStatus({
        dateISO,
        timeHM: t,
        periods,
        openingHours,
      }) === 'closed',
  )
  if (known.length && closed.length === slots.length - known.length) {
    return `open ~ ${known.join(', ')}`
  }
  if (closed.length === slots.length) return 'closed all typical slots'
  if (known.length) return `open at least ~ ${known.join(', ')}`
  return openingHours?.slice(0, 120) || ''
}
