import type { TripItem, TripRecord } from '../domain/types'
import { sortItems } from './db'

/**
 * Polarsteps has no public import API today, but GDPR exports use trip.json
 * with `all_steps`. We emit that shape so a future Polarsteps import (or a
 * third-party bridge) can consume our trips without remapping.
 *
 * @see https://support.polarsteps.com/hc/en-us/articles/24266264821138
 */
export type PolarstepsStep = {
  name: string
  description: string
  start_time: number
  end_time?: number | null
  location: {
    name: string
    lat: number | null
    lon: number | null
  }
  /** Our extensions — Polarsteps ignores unknown fields */
  transport?: string | null
  type?: string
  id?: string
  confirm?: string
  cost?: number | null
  currency?: string
}

export type PolarstepsTripJson = {
  name: string
  start_date: number
  end_date: number
  summary: string
  all_steps: PolarstepsStep[]
  _generator: 'trip-tracker'
  _format: 'polarsteps-trip-json-compatible'
  _note: string
}

function toUnix(date: string, time?: string): number {
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time : '12:00'
  const ms = Date.parse(`${date}T${t}:00`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000)
}

function stepLocationName(item: TripItem): string {
  if (item.place) return item.city ? `${item.place}, ${item.city}` : item.place
  if (item.from && item.to) return `${item.from} → ${item.to}`
  return item.city || item.title
}

function transportFor(type: TripItem['type']): string | null {
  switch (type) {
    case 'flight':
      return 'plane'
    case 'train':
      return 'train'
    case 'bus':
      return 'bus'
    case 'ferry':
      return 'boat'
    case 'drive':
      return 'car'
    default:
      return null
  }
}

export function toPolarstepsTrip(trip: TripRecord): PolarstepsTripJson {
  const steps: PolarstepsStep[] = sortItems(trip.items)
    .filter((i) => i.status !== 'cancelled' && i.type !== 'note')
    .map((item) => {
      const start = toUnix(item.date, item.start)
      const endDate = item.endDate || item.date
      const end = item.end || item.endDate ? toUnix(endDate, item.end || '23:59') : null
      return {
        id: item.id,
        name: item.title,
        description: [item.notes, item.confirm ? `Booking: ${item.confirm}` : '']
          .filter(Boolean)
          .join('\n'),
        start_time: start,
        end_time: end,
        location: {
          name: stepLocationName(item),
          lat: item.lat,
          lon: item.lon,
        },
        transport: transportFor(item.type),
        type: item.type,
        confirm: item.confirm || undefined,
        cost: item.cost,
        currency: item.currency || trip.meta.homeCurrency,
      }
    })

  return {
    name: trip.meta.name,
    start_date: toUnix(trip.meta.startDate, '00:00'),
    end_date: toUnix(trip.meta.endDate || trip.meta.startDate, '23:59'),
    summary: trip.meta.notes || '',
    all_steps: steps,
    _generator: 'trip-tracker',
    _format: 'polarsteps-trip-json-compatible',
    _note:
      'Compatible with Polarsteps GDPR trip.json all_steps shape. Official Polarsteps import is not publicly available yet — keep this file for a future bridge.',
  }
}

export function downloadPolarstepsJson(trip: TripRecord, filename?: string) {
  const payload = toPolarstepsTrip(trip)
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download =
    filename ||
    `${trip.meta.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'trip'}.polarsteps.json`
  a.click()
  URL.revokeObjectURL(url)
}
