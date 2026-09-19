/**
 * Real lodging already on the Journey (not placeholder day shells).
 * The coach must treat these as anchors — never invent alternatives over them.
 */

import type { TripItem, TripRecord } from '../domain/types'
import { isPlaceholderBase } from '../data/dayBases'

export type ExistingHotelBrief = {
  id: string
  title: string
  place: string
  city: string
  date: string
  endDate: string
  status: string
  confirm: boolean
  nights: string[]
}

export function isRealHotel(item: TripItem): boolean {
  return (
    item.type === 'hotel' &&
    !isPlaceholderBase(item) &&
    item.status !== 'cancelled'
  )
}

/** Calendar nights a hotel stay covers (check-in .. check-out inclusive of stay nights). */
export function hotelCoveredDates(item: TripItem): string[] {
  if (!isRealHotel(item) || !item.date) return []
  const end = item.endDate && item.endDate >= item.date ? item.endDate : item.date
  const out: string[] = []
  const startMs = Date.parse(`${item.date}T12:00:00`)
  const endMs = Date.parse(`${end}T12:00:00`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return item.date ? [item.date] : []
  }
  for (let t = startMs; t <= endMs && out.length < 60; t += 86_400_000) {
    const d = new Date(t)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  // Convention: endDate is often checkout morning — still include it as covered
  // for day-theme purposes; spine nights use check-in through night before checkout
  // when end > start. Keep inclusive list; callers can treat checkout day lightly.
  return out
}

export function existingHotelsBrief(trip: TripRecord): ExistingHotelBrief[] {
  return trip.items
    .filter(isRealHotel)
    .slice(0, 24)
    .map((i) => ({
      id: i.id,
      title: i.title.slice(0, 120),
      place: (i.place || '').slice(0, 200),
      city: (i.city || '').slice(0, 120),
      date: i.date,
      endDate: i.endDate || i.date,
      status: i.status,
      confirm: Boolean(i.confirm),
      nights: hotelCoveredDates(i),
    }))
}

/** Prefer the real hotel’s city/place as the stay-zone label for a calendar day. */
export function hotelAreaForDate(
  trip: TripRecord,
  date: string,
): { areaLabel: string; hotelTitle: string; itemId: string } | null {
  for (const i of trip.items) {
    if (!isRealHotel(i)) continue
    const nights = hotelCoveredDates(i)
    if (!nights.includes(date)) continue
    const areaLabel =
      (i.city || i.place || i.title.replace(/\s+hotel$/i, '')).trim() ||
      i.title.trim()
    if (!areaLabel) continue
    return {
      areaLabel: areaLabel.slice(0, 120),
      hotelTitle: i.title.slice(0, 120),
      itemId: i.id,
    }
  }
  return null
}

export function dateHasRealHotel(trip: TripRecord, date: string): boolean {
  return hotelAreaForDate(trip, date) != null
}

/** Force dayPlan areas onto booked hotel cities when the model drifts. */
export function alignDayPlanWithHotels<
  T extends { date: string; areaLabel: string; why?: string },
>(trip: TripRecord, dayPlan: T[]): T[] {
  if (!dayPlan.length) return dayPlan
  return dayPlan.map((d) => {
    const h = hotelAreaForDate(trip, d.date)
    if (!h) return d
    const why = d.why?.includes(h.hotelTitle)
      ? d.why
      : [`Based at ${h.hotelTitle}.`, d.why].filter(Boolean).join(' ').slice(0, 400)
    return {
      ...d,
      areaLabel: h.areaLabel,
      why,
    }
  })
}
