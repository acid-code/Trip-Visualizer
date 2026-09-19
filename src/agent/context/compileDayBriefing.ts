/**
 * Compile lodging + neighbor + prefs briefing for Journey Day Helper.
 */

import type { TripItem, TripRecord } from '../../domain/types'
import { isPlaceholderBase, itemTouchesDay } from '../../data/dayBases'
import { isValidCoord } from '../../data/validate'
import { getCachedPlaceProvider } from '../placeProvider'
import type {
  AgentPace,
  LodgingBrief,
  NeighborDayBrief,
  PlannerPrefs,
  TripDayBriefing,
} from '../types'

function addDaysIso(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

function isContentStop(i: TripItem): boolean {
  if (i.status === 'cancelled') return false
  if (isPlaceholderBase(i)) return false
  return !['drive', 'note', 'hotel', 'flight'].includes(i.type)
}

function sleepLabel(items: TripItem[], day: string): string {
  const overnight = items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      i.date <= day &&
      (!i.endDate || i.endDate > day),
  )
  if (overnight) return overnight.title || overnight.place || 'Hotel'
  const base = items.find(
    (i) => isPlaceholderBase(i) && itemTouchesDay(i, day),
  )
  if (base) return base.title || 'Day base'
  return 'Unknown'
}

function stopsForDay(
  items: TripItem[],
  day: string,
  which: 'morning' | 'evening',
): string[] {
  const dayItems = items
    .filter((i) => isContentStop(i) && i.date === day)
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
  const slice =
    which === 'morning' ? dayItems.slice(0, 3) : dayItems.slice(-3)
  return slice.map((i) => i.title || i.place).filter(Boolean)
}

export function compileLodgingBrief(
  items: TripItem[],
  day: string,
): LodgingBrief {
  const realHotelToday = items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      itemTouchesDay(i, day) &&
      isValidCoord(i.lat, i.lon),
  )
  const overnight = items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      i.date < day &&
      (!i.endDate || i.endDate >= day) &&
      isValidCoord(i.lat, i.lon),
  )
  const checkInToday = items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      i.date === day,
  )
  const placeholder = items.find(
    (i) => isPlaceholderBase(i) && itemTouchesDay(i, day),
  )
  const transit = items.find(
    (i) =>
      (i.type === 'flight' ||
        i.type === 'train' ||
        i.type === 'bus' ||
        i.type === 'ferry') &&
      i.date === day &&
      isValidCoord(i.latTo, i.lonTo),
  )

  const tonightHotel = realHotelToday || overnight || checkInToday || null
  let morningBase: LodgingBrief['morningBase'] = 'unknown'
  if (overnight && (!checkInToday || overnight.id === checkInToday.id)) {
    morningBase = 'same_hotel'
  } else if (checkInToday) {
    morningBase = 'check_in_today'
  } else if (placeholder && isValidCoord(placeholder.lat, placeholder.lon)) {
    morningBase = 'placeholder'
  } else if (transit) {
    morningBase = 'transit_arrival'
  }

  const checkoutToday = Boolean(
    tonightHotel?.endDate && tonightHotel.endDate === day,
  )
  const nextDay = addDaysIso(day, 1)
  const sleepTonight = sleepLabel(items, day)
  const sleepTomorrow = sleepLabel(items, nextDay)
  const nextNightDifferent =
    sleepTonight !== 'Unknown' &&
    sleepTomorrow !== 'Unknown' &&
    sleepTonight.toLowerCase() !== sleepTomorrow.toLowerCase()

  return {
    tonight: tonightHotel
      ? {
          title: tonightHotel.title,
          place: tonightHotel.place,
          lat: tonightHotel.lat,
          lon: tonightHotel.lon,
          checkIn: tonightHotel.date,
          checkOut: tonightHotel.endDate || '',
        }
      : placeholder && isValidCoord(placeholder.lat, placeholder.lon)
        ? {
            title: placeholder.title || 'Area base',
            place: placeholder.place || '',
            lat: placeholder.lat,
            lon: placeholder.lon,
            checkIn: placeholder.date,
            checkOut: placeholder.endDate || '',
          }
        : null,
    morningBase,
    checkoutToday,
    nextNightDifferent,
  }
}

export function compileNeighborBrief(
  items: TripItem[],
  day: string,
  which: 'yesterday' | 'tomorrow',
): NeighborDayBrief | null {
  const date = addDaysIso(day, which === 'yesterday' ? -1 : 1)
  const has =
    items.some((i) => i.date === date && i.status !== 'cancelled') ||
    items.some((i) => itemTouchesDay(i, date))
  if (!has) return null
  const content = items.filter((i) => isContentStop(i) && i.date === date)
  const summary =
    content.length === 0
      ? 'Light / travel / empty'
      : `${content.length} stop${content.length === 1 ? '' : 's'}`
  return {
    date,
    summary,
    eveningStops: stopsForDay(items, date, 'evening'),
    morningStops: stopsForDay(items, date, 'morning'),
    sleepAt: sleepLabel(items, date),
  }
}

export function prefsFromMeta(trip: TripRecord): PlannerPrefs {
  const raw = trip.meta.plannerPrefs || {}
  const vibe = (trip.meta.vibe || '')
    .split(/[,;/|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
  return {
    ...raw,
    vibe: raw.vibe?.length ? raw.vibe : vibe.length ? vibe : raw.vibe,
  }
}

export function mergePlannerPrefs(
  trip: TripRecord,
  patch: Partial<PlannerPrefs>,
): TripRecord {
  const prev = prefsFromMeta(trip)
  const next: PlannerPrefs = {
    ...prev,
    ...patch,
    vibe: patch.vibe ?? prev.vibe,
    food: patch.food ?? prev.food,
    mustSees: patch.mustSees ?? prev.mustSees,
    avoid: patch.avoid ?? prev.avoid,
    notes: [...(prev.notes || []), ...(patch.notes || [])].slice(-20),
    adoptedAreas: patch.adoptedAreas ?? prev.adoptedAreas,
  }
  return {
    ...trip,
    meta: {
      ...trip.meta,
      plannerPrefs: next,
      vibe:
        trip.meta.vibe ||
        (next.vibe?.length ? next.vibe.join(', ') : trip.meta.vibe),
    },
  }
}

function paceFromPrefs(prefs: PlannerPrefs): AgentPace {
  return prefs.pace || 'unknown'
}

export function compileTripDayBriefing(
  trip: TripRecord,
  day: string,
): TripDayBriefing {
  const prefs = prefsFromMeta(trip)
  const lodging = compileLodgingBrief(trip.items, day)
  const areaLabel =
    lodging.tonight?.title ||
    lodging.tonight?.place ||
    prefs.adoptedAreas?.[0] ||
    ''

  const avoided: string[] = []
  const seen = new Set<string>()
  for (const i of trip.items) {
    if (!isContentStop(i) || i.date === day) continue
    const n = (i.title || i.place || '').trim()
    if (!n) continue
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    avoided.push(n)
    if (avoided.length >= 12) break
  }

  return {
    day,
    lodging,
    neighbors: {
      yesterday: compileNeighborBrief(trip.items, day, 'yesterday'),
      tomorrow: compileNeighborBrief(trip.items, day, 'tomorrow'),
    },
    areaContext: areaLabel
      ? {
          label: areaLabel,
          kind: 'neighborhood',
          vibeTags: prefs.vibe || [],
          notes: (prefs.notes || []).slice(-3).join('; '),
        }
      : null,
    tripMemory: {
      avoidedPlaces: avoided,
      userPrefs: [
        ...(prefs.vibe || []),
        ...(prefs.food || []),
        ...(prefs.notes || []).slice(-5),
      ].slice(0, 16),
      pace: paceFromPrefs(prefs),
    },
    caveats: [],
    placeProvider: getCachedPlaceProvider() || 'osm',
  }
}

/** Extra planningHints lines for Gemini from briefing. */
export function briefingToPlanningHints(b: TripDayBriefing): string[] {
  const hints: string[] = []
  if (b.lodging.tonight) {
    hints.push(
      `Lodging context: ${b.lodging.tonight.title} (${b.lodging.morningBase}; checkoutToday=${b.lodging.checkoutToday}; nextNightDifferent=${b.lodging.nextNightDifferent}).`,
    )
  } else {
    hints.push('No confirmed hotel — plan around area day-base / arrival only. Never invent hotel names.')
  }
  if (b.neighbors.yesterday) {
    hints.push(
      `Yesterday (${b.neighbors.yesterday.date}): ${b.neighbors.yesterday.summary}; slept at ${b.neighbors.yesterday.sleepAt}; evening: ${b.neighbors.yesterday.eveningStops.join(', ') || '—'}.`,
    )
  }
  if (b.neighbors.tomorrow) {
    hints.push(
      `Tomorrow (${b.neighbors.tomorrow.date}): ${b.neighbors.tomorrow.summary}; sleep ${b.neighbors.tomorrow.sleepAt}; morning: ${b.neighbors.tomorrow.morningStops.join(', ') || '—'}.`,
    )
  }
  if (b.areaContext) {
    hints.push(
      `Area context: ${b.areaContext.label} [${b.areaContext.vibeTags.join(', ') || 'no vibe tags'}]. Prefer same-area fills; day-trips along trip corridor.`,
    )
  }
  if (b.tripMemory.userPrefs.length) {
    hints.push(`User prefs: ${b.tripMemory.userPrefs.join('; ')}.`)
  }
  if (b.tripMemory.pace !== 'unknown') {
    hints.push(`Preferred pace: ${b.tripMemory.pace}. Offer soft/balanced/packed alternatives when filling.`)
  }
  hints.push(
    `Walk cap ~${1.5} km per leg unless prefs say otherwise; longer hops need explicit drive/transit From→To.`,
  )
  hints.push(
    `Place provider: ${b.placeProvider}. Ratings/hours may be sparse on OSM — do not require Google-quality fields.`,
  )
  hints.push('Never propose specific hotel names or bookings.')
  return hints
}
