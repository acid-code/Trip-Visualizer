import type { TripItem, TripMeta } from '../domain/types'
import { TYPE_COLORS } from '../domain/types'
import { convertAmount, normalizeCurrency, type FxRates } from './fx'
import { isIsoDate } from './validate'

export function nightsPerCity(items: TripItem[]): { city: string; nights: number }[] {
  const map = new Map<string, number>()
  for (const item of items) {
    if (item.type !== 'hotel' || !item.city || !isIsoDate(item.date) || !isIsoDate(item.endDate)) {
      continue
    }
    const start = new Date(item.date + 'T00:00:00')
    const end = new Date(item.endDate + 'T00:00:00')
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue
    const nights = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000))
    map.set(item.city, (map.get(item.city) ?? 0) + nights)
  }
  return [...map.entries()]
    .map(([city, nights]) => ({ city, nights }))
    .sort((a, b) => b.nights - a.nights)
}

export type SpendSummary = {
  homeCurrency: string
  /** Total converted into home currency */
  totalHome: number
  /** Original amounts summed per currency (no conversion) */
  byOriginalCurrency: { currency: string; total: number }[]
  slices: { type: string; value: number; color: string }[]
  /** Steps that had a cost but could not be converted */
  skipped: number
  ratesDate: string
}

export function spendSummary(
  items: TripItem[],
  homeCurrencyRaw: string,
  rates: FxRates,
): SpendSummary {
  const homeCurrency = normalizeCurrency(homeCurrencyRaw, 'EUR')
  const byType = new Map<string, number>()
  const byOrig = new Map<string, number>()
  let totalHome = 0
  let skipped = 0

  for (const item of items) {
    if (item.cost == null || !Number.isFinite(item.cost) || item.status === 'cancelled') continue
    if (item.tags?.includes('placeholder')) continue

    const cur = normalizeCurrency(item.currency, homeCurrency)
    byOrig.set(cur, (byOrig.get(cur) ?? 0) + item.cost)

    const converted = convertAmount(item.cost, cur, homeCurrency, rates)
    if (converted == null) {
      skipped += 1
      continue
    }
    totalHome += converted
    byType.set(item.type, (byType.get(item.type) ?? 0) + converted)
  }

  return {
    homeCurrency,
    totalHome,
    byOriginalCurrency: [...byOrig.entries()]
      .map(([currency, total]) => ({ currency, total }))
      .sort((a, b) => b.total - a.total),
    slices: [...byType.entries()].map(([type, value]) => ({
      type,
      value,
      color: TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? '#94a3b8',
    })),
    skipped,
    ratesDate: rates.date,
  }
}

export function costsByType(items: TripItem[], homeCurrency: string) {
  const map = new Map<string, number>()
  for (const item of items) {
    if (item.cost == null || !Number.isFinite(item.cost) || item.status === 'cancelled') continue
    if (item.tags?.includes('placeholder')) continue
    map.set(item.type, (map.get(item.type) ?? 0) + item.cost)
  }
  return {
    currency: homeCurrency,
    slices: [...map.entries()].map(([type, value]) => ({
      type,
      value,
      color: TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? '#94a3b8',
    })),
  }
}

export function typeMix(items: TripItem[]) {
  const map = new Map<string, number>()
  for (const item of items) {
    if (item.status === 'cancelled') continue
    map.set(item.type, (map.get(item.type) ?? 0) + 1)
  }
  return [...map.entries()].map(([type, count]) => ({
    type,
    count,
    color: TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? '#94a3b8',
  }))
}

export function tripDays(meta: TripMeta, items: TripItem[]): string[] {
  const dates = new Set<string>()
  if (isIsoDate(meta.startDate)) dates.add(meta.startDate)
  if (isIsoDate(meta.endDate)) dates.add(meta.endDate)
  for (const item of items) {
    if (isIsoDate(item.date)) dates.add(item.date)
    if (isIsoDate(item.endDate)) dates.add(item.endDate)
  }
  return [...dates].sort()
}

export function dayIndex(meta: TripMeta, date: string): number {
  if (!isIsoDate(meta.startDate) || !isIsoDate(date)) return 0
  const a = new Date(meta.startDate + 'T00:00:00').getTime()
  const b = new Date(date + 'T00:00:00').getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86400000) + 1
}

/** Per-item day number + order within that day (non-cancelled, non-note). */
export function stepOrderMap(
  meta: TripMeta,
  items: TripItem[],
): Map<string, { day: number; stepInDay: number }> {
  const sorted = [...items]
    .filter((i) => i.status !== 'cancelled' && i.type !== 'note')
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date)
      if (d !== 0) return d
      return (a.start || '99:99').localeCompare(b.start || '99:99')
    })

  const map = new Map<string, { day: number; stepInDay: number }>()
  const perDay = new Map<string, number>()
  for (const item of sorted) {
    const day = dayIndex(meta, item.date)
    const n = (perDay.get(item.date) ?? 0) + 1
    perDay.set(item.date, n)
    map.set(item.id, { day, stepInDay: n })
  }
  return map
}

export function totalCost(items: TripItem[]): number {
  return items.reduce((sum, i) => {
    if (i.cost == null || !Number.isFinite(i.cost) || i.status === 'cancelled') return sum
    if (i.tags?.includes('placeholder')) return sum
    return sum + i.cost
  }, 0)
}

export function greatCircleDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export function distanceStats(items: TripItem[]) {
  let airKm = 0
  let roadKm = 0
  for (const item of items) {
    if (item.lat == null || item.lon == null || item.latTo == null || item.lonTo == null) continue
    const d = greatCircleDistanceKm(item.lat, item.lon, item.latTo, item.lonTo)
    if (item.type === 'flight') airKm += d
    if (item.type === 'drive' || item.type === 'train' || item.type === 'bus') roadKm += d
  }
  return { airKm: Math.round(airKm), roadKm: Math.round(roadKm) }
}
