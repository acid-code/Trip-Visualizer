import type { TripItem, TripMeta } from '../domain/types'
import { dayIndex } from './analytics'
import { createId, sortItems } from './db'
import { isIsoDate, requireIsoDate, sanitizeMetaDates } from './validate'

const ARRIVAL_TYPES = new Set(['flight', 'train', 'bus', 'ferry', 'drive', 'hotel'])
const MAX_TRIP_DAYS = 400

function isDayBase(item: TripItem, day: string): boolean {
  if (item.status === 'cancelled' || item.type === 'note') return false
  if (item.type === 'hotel') {
    if (item.date === day) return true
    if (item.endDate && item.date < day && item.endDate >= day) return true
    return false
  }
  return ARRIVAL_TYPES.has(item.type) && item.date === day
}

export function isPlaceholderBase(item: TripItem): boolean {
  return item.tags?.includes('day-base') === true && item.tags?.includes('placeholder') === true
}

/** True if the step starts on `day`, or a hotel stay covers that calendar day. */
export function itemTouchesDay(item: TripItem, day: string): boolean {
  if (item.date === day) return true
  if (item.type === 'hotel' && item.endDate && item.date < day && item.endDate >= day) {
    return true
  }
  // Explicit end-date match (e.g. checkout day listed on filter)
  if (item.endDate === day && item.date !== day) return true
  return false
}

function emptyBase(day: string, dayNum: number, currency: string): TripItem {
  return {
    id: createId('B'),
    type: 'hotel',
    title: `Day ${dayNum} base`,
    place: '',
    city: '',
    date: day,
    endDate: day,
    start: '00:00',
    end: '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency,
    status: 'planned',
    notes:
      'Placeholder — set this to your hotel / sleep spot, or replace with an arrival (airport / station / drive).',
    url: '',
    tags: ['day-base', 'placeholder'],
    lat: null,
    lon: null,
    latTo: null,
    lonTo: null,
    wikidata: '',
    osmId: '',
    geocodeQuery: '',
    updatedAt: '',
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
  }
}

function enumerateDays(start: string, end: string): string[] {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) return []
  const out: string[] = []
  const cur = new Date(start + 'T12:00:00')
  const last = new Date(end + 'T12:00:00')
  if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime())) return []
  // Cap runaway ranges (bad Excel / corrupted meta)
  const maxDays = MAX_TRIP_DAYS
  while (cur <= last && out.length < maxDays) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

function isRealStep(item: TripItem): boolean {
  if (item.status === 'cancelled' || item.type === 'note') return false
  if (isPlaceholderBase(item)) return false
  return true
}

function touchesDay(item: TripItem, day: string): boolean {
  return itemTouchesDay(item, day)
}

function dayHasRealSteps(items: TripItem[], day: string): boolean {
  return items.some((i) => isRealStep(i) && touchesDay(i, day))
}

/** Ensure every day starts with a hotel/sleep or transport arrival slot. */
export function ensureDayStartBases(
  meta: TripMeta,
  items: TripItem[],
): TripItem[] {
  const sorted = sortItems(items)
  const days = new Set<string>()
  if (isIsoDate(meta.startDate) && isIsoDate(meta.endDate)) {
    for (const day of enumerateDays(meta.startDate, meta.endDate)) days.add(day)
  }
  for (const item of sorted) {
    if (isIsoDate(item.date)) days.add(item.date)
    if (isIsoDate(item.endDate)) days.add(item.endDate)
  }

  const extras: TripItem[] = []
  for (const day of [...days].sort()) {
    const dayItems = sorted.filter(
      (i) =>
        i.status !== 'cancelled' &&
        i.type !== 'note' &&
        (i.date === day || (i.type === 'hotel' && i.endDate && i.date < day && i.endDate >= day)),
    )
    const firstOfDay = sortItems(
      sorted.filter((i) => i.date === day && i.status !== 'cancelled' && i.type !== 'note'),
    )[0]

    const hasBase =
      (firstOfDay && isDayBase(firstOfDay, day)) ||
      dayItems.some((i) => i.type === 'hotel' && isDayBase(i, day))

    const alreadyPlaceholder = sorted.some(
      (i) =>
        i.date === day &&
        i.tags?.includes('day-base') &&
        i.tags?.includes('placeholder'),
    )

    if (!hasBase && !alreadyPlaceholder) {
      extras.push(emptyBase(day, dayIndex(meta, day), meta.homeCurrency))
    }
  }

  if (!extras.length) return sorted
  return sortItems([...sorted, ...extras])
}

/**
 * After deleting a step:
 * - Trailing days with no real steps are removed (shrink end date).
 * - Empty middle days keep only a day-base placeholder when later days still have steps.
 */
export function pruneEmptyDays(
  meta: TripMeta,
  items: TripItem[],
): { meta: TripMeta; items: TripItem[] } {
  let nextItems = sortItems(items)
  const start = requireIsoDate(
    meta.startDate || nextItems.find((i) => isIsoDate(i.date))?.date,
  )

  const itemDays = nextItems.flatMap((i) =>
    [i.date, i.endDate].filter((d): d is string => isIsoDate(d)),
  )
  const roughEnd =
    [meta.endDate, ...itemDays].filter((d): d is string => isIsoDate(d)).sort().at(-1) ||
    start

  const days = enumerateDays(start, roughEnd)
  const lastReal =
    [...days].reverse().find((d) => dayHasRealSteps(nextItems, d)) ?? null

  if (!lastReal) {
    const metaOne = { ...meta, startDate: start, endDate: start }
    nextItems = nextItems.filter((i) => !i.date || i.date === start)
    nextItems = nextItems.filter((i) => !(isPlaceholderBase(i) && i.date === start))
    return {
      meta: metaOne,
      items: ensureDayStartBases(metaOne, nextItems),
    }
  }

  // Drop items that only live after the last real day
  nextItems = nextItems.filter((i) => !i.date || i.date <= lastReal)
  nextItems = nextItems.map((i) => {
    if (i.type === 'hotel' && i.endDate && i.endDate > lastReal) {
      return { ...i, endDate: lastReal }
    }
    return i
  })

  // Middle empty days: strip everything on that calendar day (base re-added below)
  for (const day of enumerateDays(start, lastReal)) {
    if (dayHasRealSteps(nextItems, day)) continue
    nextItems = nextItems.filter((i) => i.date !== day)
  }

  const metaNext = { ...meta, startDate: start, endDate: lastReal }
  return {
    meta: metaNext,
    items: ensureDayStartBases(metaNext, nextItems),
  }
}

/** Remove a step, then prune empty days. */
export function deleteStepAndPrune(
  meta: TripMeta,
  items: TripItem[],
  stepId: string,
): { meta: TripMeta; items: TripItem[] } {
  return pruneEmptyDays(
    meta,
    items.filter((i) => i.id !== stepId),
  )
}

export function countTripDays(startDate: string, endDate: string): number {
  return enumerateDays(startDate, endDate).length
}

function itemOutsideRange(item: TripItem, start: string, end: string): boolean {
  if (!isIsoDate(item.date)) return false
  if (item.type === 'hotel' && isIsoDate(item.endDate)) {
    // Fully outside if stay ends before start or begins after end
    return item.endDate < start || item.date > end
  }
  return item.date < start || item.date > end
}

/** Real (non-placeholder) steps that fall fully outside the proposed date range. */
export function stepsOutsideRange(
  items: TripItem[],
  startDate: string,
  endDate: string,
): TripItem[] {
  const { startDate: start, endDate: end } = sanitizeMetaDates(startDate, endDate)
  return items.filter(
    (i) =>
      i.status !== 'cancelled' &&
      !isPlaceholderBase(i) &&
      itemOutsideRange(i, start, end),
  )
}

export type RangeReconcileMode = 'keep-outside' | 'drop-outside'

/**
 * Apply a new trip name + date range.
 * - Always drops placeholder bases outside the chosen window.
 * - `keep-outside`: widen dates to include leftover real steps.
 * - `drop-outside`: remove real steps (and clip hotels) that fall outside.
 * Then re-seeds day-base placeholders for every day in range.
 */
export function applyTripMetaRange(
  meta: TripMeta,
  items: TripItem[],
  next: { name: string; startDate: string; endDate: string },
  mode: RangeReconcileMode = 'keep-outside',
): { meta: TripMeta; items: TripItem[]; widened: boolean; removedCount: number } {
  let dates = sanitizeMetaDates(next.startDate, next.endDate)
  let nextItems = sortItems(items)
  let removedCount = 0
  let widened = false

  // Always strip placeholder bases outside the chosen window
  nextItems = nextItems.filter((i) => {
    if (!isPlaceholderBase(i)) return true
    if (!isIsoDate(i.date)) return false
    return i.date >= dates.startDate && i.date <= dates.endDate
  })

  if (mode === 'drop-outside') {
    const before = nextItems.length
    nextItems = nextItems
      .filter((i) => isPlaceholderBase(i) || !itemOutsideRange(i, dates.startDate, dates.endDate))
      .map((i) => {
        if (i.type !== 'hotel' || !isIsoDate(i.endDate)) return i
        let date = i.date
        let endDate = i.endDate
        if (date < dates.startDate) date = dates.startDate
        if (endDate > dates.endDate) endDate = dates.endDate
        if (endDate < date) endDate = date
        return { ...i, date, endDate }
      })
    removedCount = Math.max(0, before - nextItems.length)
  } else {
    // Widen to keep real steps that sit outside the typed dates
    for (const i of nextItems) {
      if (isPlaceholderBase(i) || i.status === 'cancelled') continue
      if (!isIsoDate(i.date)) continue
      if (i.date < dates.startDate) {
        dates = { ...dates, startDate: i.date }
        widened = true
      }
      const end = isIsoDate(i.endDate) ? i.endDate : i.date
      if (end > dates.endDate) {
        dates = { ...dates, endDate: end }
        widened = true
      }
    }
  }

  const name = next.name.trim() || 'Untitled trip'
  const metaOut: TripMeta = {
    ...meta,
    name,
    startDate: dates.startDate,
    endDate: dates.endDate,
  }

  return {
    meta: metaOut,
    items: ensureDayStartBases(metaOut, nextItems),
    widened,
    removedCount,
  }
}
