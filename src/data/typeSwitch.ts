/** Remember per-type field snapshots when the user toggles a step’s type. */

import type { ItemType, TripItem } from '../domain/types'
import { sanitizeEndDate } from './validate'

const LEG_TYPES = new Set<ItemType>(['flight', 'train', 'bus', 'ferry', 'drive'])

export function isLegType(type: ItemType): boolean {
  return LEG_TYPES.has(type)
}

/** Fields restored when returning to a type the user already tried. */
export type TypeFieldSnap = {
  title: string
  place: string
  city: string
  date: string
  endDate: string
  start: string
  end: string
  from: string
  to: string
  confirm: string
  cost: number | null
  currency: string
  notes: string
  url: string
  geocodeQuery: string
  lat: number | null
  lon: number | null
  latTo: number | null
  lonTo: number | null
  routeCoords: [number, number][]
  enrichmentSummary: string
  enrichmentImage: string
  enrichmentSource: string
}

/** Shared across types — always carried forward when switching. */
const SHARED_KEYS = [
  'title',
  'place',
  'city',
  'date',
  'confirm',
  'cost',
  'currency',
  'status',
  'notes',
  'url',
  'geocodeQuery',
] as const

type SharedKey = (typeof SHARED_KEYS)[number]

const memory = new Map<string, Partial<Record<ItemType, TypeFieldSnap>>>()

function cloneCoords(coords: [number, number][] | undefined): [number, number][] {
  return (coords ?? []).map((c) => [c[0], c[1]] as [number, number])
}

export function snapshotTypeFields(item: TripItem): TypeFieldSnap {
  return {
    title: item.title,
    place: item.place,
    city: item.city,
    date: item.date,
    endDate: item.endDate,
    start: item.start,
    end: item.end,
    from: item.from,
    to: item.to,
    confirm: item.confirm,
    cost: item.cost,
    currency: item.currency,
    notes: item.notes,
    url: item.url,
    geocodeQuery: item.geocodeQuery,
    lat: item.lat,
    lon: item.lon,
    latTo: item.latTo,
    lonTo: item.lonTo,
    routeCoords: cloneCoords(item.routeCoords),
    enrichmentSummary: item.enrichmentSummary,
    enrichmentImage: item.enrichmentImage,
    enrichmentSource: item.enrichmentSource,
  }
}

function nonEmptyStr(v: string | undefined | null): boolean {
  return Boolean(v && String(v).trim())
}

/** Prefer current value when filled; otherwise fall back to snapshot. */
function preferCurrent<T>(current: T, snap: T, filled: (v: T) => boolean): T {
  return filled(current) ? current : snap
}

function applySnapForType(
  base: TripItem,
  snap: TypeFieldSnap,
  type: ItemType,
): TripItem {
  const leg = isLegType(type)
  const hotel = type === 'hotel'

  // Shared: keep what the user just had if filled, else restore from this type’s snap
  const shared: Pick<TripItem, SharedKey> = {
    title: preferCurrent(base.title, snap.title, nonEmptyStr),
    place: preferCurrent(base.place, snap.place, nonEmptyStr),
    city: preferCurrent(base.city, snap.city, nonEmptyStr),
    date: preferCurrent(base.date, snap.date, nonEmptyStr),
    confirm: preferCurrent(base.confirm, snap.confirm, nonEmptyStr),
    cost: base.cost != null ? base.cost : snap.cost,
    currency: preferCurrent(base.currency, snap.currency, nonEmptyStr),
    status: base.status,
    notes: preferCurrent(base.notes, snap.notes, nonEmptyStr),
    url: preferCurrent(base.url, snap.url, nonEmptyStr),
    geocodeQuery: preferCurrent(base.geocodeQuery, snap.geocodeQuery, nonEmptyStr),
  }

  const lat = preferCurrent(base.lat, snap.lat, (v) => v != null)
  const lon = preferCurrent(base.lon, snap.lon, (v) => v != null)

  let endDate = ''
  if (hotel || leg) {
    endDate = sanitizeEndDate(
      shared.date,
      preferCurrent(base.endDate, snap.endDate, nonEmptyStr),
    )
  }

  return {
    ...base,
    ...shared,
    type,
    endDate,
    start: preferCurrent(base.start, snap.start, nonEmptyStr),
    end: preferCurrent(base.end, snap.end, nonEmptyStr),
    from: leg ? preferCurrent(base.from, snap.from, nonEmptyStr) : '',
    to: leg ? preferCurrent(base.to, snap.to, nonEmptyStr) : '',
    lat,
    lon,
    latTo: leg ? preferCurrent(base.latTo, snap.latTo, (v) => v != null) : null,
    lonTo: leg ? preferCurrent(base.lonTo, snap.lonTo, (v) => v != null) : null,
    routeCoords: leg
      ? snap.routeCoords.length
        ? cloneCoords(snap.routeCoords)
        : cloneCoords(base.routeCoords)
      : [],
    enrichmentSummary: preferCurrent(
      base.enrichmentSummary,
      snap.enrichmentSummary,
      nonEmptyStr,
    ),
    enrichmentImage: preferCurrent(
      base.enrichmentImage,
      snap.enrichmentImage,
      nonEmptyStr,
    ),
    enrichmentSource: preferCurrent(
      base.enrichmentSource,
      snap.enrichmentSource,
      nonEmptyStr,
    ),
  }
}

/** First time on a type: keep shared fields, drop what doesn’t belong. */
function reshapeWithoutSnap(item: TripItem, type: ItemType): TripItem {
  const leg = isLegType(type)
  const hotel = type === 'hotel'
  const endDate =
    hotel || leg ? sanitizeEndDate(item.date, item.endDate || '') : ''

  return {
    ...item,
    type,
    endDate,
    from: leg ? item.from : '',
    to: leg ? item.to : '',
    latTo: leg ? item.latTo : null,
    lonTo: leg ? item.lonTo : null,
    routeCoords: leg ? cloneCoords(item.routeCoords) : [],
    // Keep title, place, city, date, confirm, cost, notes, lat/lon, times — shared
  }
}

/**
 * Switch step type while remembering each type’s last field set for this item id.
 * Shared fields (confirm, place, cost, …) always carry; type-specific fields restore
 * when the user returns to a type they already used.
 */
export function applyItemTypeChange(item: TripItem, newType: ItemType): TripItem {
  if (item.type === newType) return item

  const byType = memory.get(item.id) ?? {}
  byType[item.type] = snapshotTypeFields(item)
  memory.set(item.id, byType)

  const prior = byType[newType]
  if (prior) {
    return applySnapForType(item, prior, newType)
  }
  return reshapeWithoutSnap(item, newType)
}

/** Seed memory with the item’s current type (call when opening the editor). */
export function rememberCurrentType(item: TripItem): void {
  const byType = memory.get(item.id) ?? {}
  if (!byType[item.type]) {
    byType[item.type] = snapshotTypeFields(item)
    memory.set(item.id, byType)
  }
}

export function clearTypeSwitchMemory(itemId: string): void {
  memory.delete(itemId)
}
