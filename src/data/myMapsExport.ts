/**
 * Build My Maps–friendly CSV layers from a trip (Plan POIs + Journey stops).
 */

import {
  TYPE_EMOJI,
  type ItemType,
  type PlanPlace,
  type PlanSection,
  type TripItem,
  type TripRecord,
} from '../domain/types'
import { JOURNEY_SECTION_TITLE } from './planBoard'

export const MY_MAPS_LAYER_COLUMNS = [
  'Name',
  'Latitude',
  'Longitude',
  'Description',
  'Day',
  'Section',
  'Type',
  'Maps URL',
] as const

export type MyMapsLayerKind = 'plan' | 'journey'

export type MyMapsLayerRow = {
  name: string
  lat: number
  lon: number
  description: string
  day: string
  section: string
  type: string
  mapsUrl: string
}

export type MyMapsLayerBuild = {
  kind: MyMapsLayerKind
  rows: MyMapsLayerRow[]
  csv: string
  /** Drive/Sheets display name base suffix, e.g. "Plan" / "Journey". */
  label: string
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function rowsToCsv(rows: MyMapsLayerRow[]): string {
  const header = MY_MAPS_LAYER_COLUMNS.join(',')
  const lines = rows.map((r) =>
    [
      csvEscape(r.name),
      String(r.lat),
      String(r.lon),
      csvEscape(r.description),
      csvEscape(r.day),
      csvEscape(r.section),
      csvEscape(r.type),
      csvEscape(r.mapsUrl),
    ].join(','),
  )
  return [header, ...lines].join('\r\n')
}

/** Prefix title with emoji for My Maps labels (skip if already present). */
export function nameWithEmoji(emoji: string, title: string): string {
  const name = title.trim() || 'Place'
  const icon = emoji.trim()
  if (!icon) return name
  if (name.startsWith(icon)) return name
  return `${icon} ${name}`
}

function sectionMetaById(
  sections: PlanSection[],
): Map<string, { title: string; icon: string }> {
  const map = new Map<string, { title: string; icon: string }>()
  for (const s of sections) {
    map.set(s.id, { title: s.title, icon: s.icon?.trim() || '📍' })
  }
  return map
}

/** Journey mirrors live under “On the trip” — keep those on the Journey layer only. */
function isOnTheTripSection(title: string | undefined): boolean {
  if (!title) return false
  const t = title.toLowerCase()
  return title === JOURNEY_SECTION_TITLE || t === 'journey' || t === 'on the trip'
}

function placeDescription(p: PlanPlace): string {
  const parts: string[] = []
  if (p.place?.trim()) parts.push(p.place.trim())
  if (p.city?.trim()) parts.push(p.city.trim())
  if (p.notes?.trim()) parts.push(p.notes.trim())
  return parts.join(' · ')
}

function itemDescription(item: TripItem): string {
  const parts: string[] = []
  if (item.place?.trim()) parts.push(item.place.trim())
  if (item.city?.trim()) parts.push(item.city.trim())
  const time =
    item.start || item.end
      ? [item.start, item.end].filter(Boolean).join('–')
      : ''
  if (time) parts.push(time)
  if (item.notes?.trim()) parts.push(item.notes.trim())
  return parts.join(' · ')
}

function coordsOrNull(
  lat: number | null | undefined,
  lon: number | null | undefined,
): { lat: number; lon: number } | null {
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null
  }
  return { lat, lon }
}

/** Plan list POIs with coordinates (Must see, Food, Maybe, … — not “On the trip”). */
export function buildPlanLayerRows(trip: TripRecord): MyMapsLayerRow[] {
  const sections = sectionMetaById(trip.planSections ?? [])
  const rows: MyMapsLayerRow[] = []
  for (const p of trip.planPlaces ?? []) {
    const sec = sections.get(p.sectionId)
    if (isOnTheTripSection(sec?.title)) continue
    const coords = coordsOrNull(p.lat, p.lon)
    if (!coords) continue
    rows.push({
      name: nameWithEmoji(sec?.icon || '📍', p.name.trim() || 'Place'),
      lat: coords.lat,
      lon: coords.lon,
      description: placeDescription(p),
      day: p.scheduledDay?.trim() || '',
      section: sec?.title || '',
      type: '',
      mapsUrl: (p.googleMapsUri || p.url || '').trim(),
    })
  }
  return rows
}

/** Dated Journey stops with coordinates. */
export function buildJourneyLayerRows(trip: TripRecord): MyMapsLayerRow[] {
  const rows: MyMapsLayerRow[] = []
  for (const item of trip.items ?? []) {
    if (!item.date?.trim()) continue
    if (item.tags?.includes('placeholder')) continue
    const coords = coordsOrNull(item.lat, item.lon)
    if (!coords) continue
    const emoji = TYPE_EMOJI[item.type as ItemType] ?? '✨'
    rows.push({
      name: nameWithEmoji(emoji, item.title.trim() || 'Stop'),
      lat: coords.lat,
      lon: coords.lon,
      description: itemDescription(item),
      day: item.date.trim(),
      section: '',
      type: item.type,
      mapsUrl: (item.googleMapsUri || item.url || '').trim(),
    })
  }
  return rows
}

export function buildMyMapsLayers(trip: TripRecord): {
  plan: MyMapsLayerBuild
  journey: MyMapsLayerBuild
} {
  const planRows = buildPlanLayerRows(trip)
  const journeyRows = buildJourneyLayerRows(trip)
  return {
    plan: {
      kind: 'plan',
      rows: planRows,
      csv: rowsToCsv(planRows),
      label: 'Plan',
    },
    journey: {
      kind: 'journey',
      rows: journeyRows,
      csv: rowsToCsv(journeyRows),
      label: 'Journey',
    },
  }
}

export const MY_MAPS_HOME_URL = 'https://www.google.com/mymaps'
