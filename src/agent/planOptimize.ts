/**
 * Plan Day Optimizer — meal arc + area cluster + walk-fatigue scoring.
 * Local-first (no Places dependency). Optional Gemini polish later.
 */

import type { PlanPlace, TripRecord } from '../domain/types'
import { isPlaceholderBase, itemTouchesDay } from '../data/dayBases'
import { reorderDayPlaces } from '../data/planBoard'
import { isValidCoord } from '../data/validate'
import { prefsFromMeta } from './context/compileDayBriefing'
import type { PlanOptimizeResult } from './types'

export type PlaceKind =
  | 'cafe'
  | 'lunch'
  | 'dinner'
  | 'sight'
  | 'nature'
  | 'activity'
  | 'other'

function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function classifyPlanPlace(p: PlanPlace): PlaceKind {
  const blob = `${p.name} ${p.place} ${p.cuisine} ${p.notes}`.toLowerCase()
  if (/cafe|café|coffee|bakery|breakfast|brunch/.test(blob)) return 'cafe'
  if (/dinner|steak|romantic|fine\s*dining|wine\s*bar/.test(blob)) return 'dinner'
  if (
    /restaurant|lunch|trattoria|pizzeria|bistro|food|ramen|sushi|kebab/.test(
      blob,
    )
  ) {
    return 'lunch'
  }
  if (/hike|trail|park|beach|lake|nature|viewpoint|garden/.test(blob)) {
    return 'nature'
  }
  if (/museum|cathedral|church|castle|palace|gallery|old\s*town|sight/.test(blob)) {
    return 'sight'
  }
  if (/spa|market|shop|tour|activity|class/.test(blob)) return 'activity'
  return 'other'
}

function mealSlotScore(kind: PlaceKind, index: number, n: number): number {
  const t = n <= 1 ? 0.5 : index / (n - 1)
  if (kind === 'cafe') return t < 0.35 ? 0 : (t - 0.35) * 4
  if (kind === 'lunch') return Math.abs(t - 0.45) * 3
  if (kind === 'dinner') return t > 0.65 ? 0 : (0.65 - t) * 4
  return 0
}

function scoreOrder(
  ordered: PlanPlace[],
  maxWalkKm: number,
  hotel: { lat: number; lon: number } | null,
): { score: number; summaryParts: string[] } {
  let score = 0
  const summaryParts: string[] = []
  const n = ordered.length
  const kinds = ordered.map(classifyPlanPlace)

  for (let i = 0; i < n; i++) {
    score += mealSlotScore(kinds[i]!, i, n)
  }

  let walkOver = 0
  let totalKm = 0
  for (let i = 0; i < n - 1; i++) {
    const a = ordered[i]!
    const b = ordered[i + 1]!
    const km = haversineKm(
      { lat: a.lat!, lon: a.lon! },
      { lat: b.lat!, lon: b.lon! },
    )
    totalKm += km
    if (km > maxWalkKm) {
      walkOver++
      score += (km - maxWalkKm) * 2
    } else {
      score += km * 0.15
    }
  }

  if (hotel && ordered[0]) {
    const toFirst = haversineKm(hotel, {
      lat: ordered[0].lat!,
      lon: ordered[0].lon!,
    })
    score += toFirst * 0.4
  }
  if (hotel && ordered[n - 1]) {
    const fromLast = haversineKm(hotel, {
      lat: ordered[n - 1]!.lat!,
      lon: ordered[n - 1]!.lon!,
    })
    score += fromLast * 0.35
  }

  // Prefer finishing one geographic cluster: penalize long jumps mid-list
  for (let i = 1; i < n - 1; i++) {
    const prev = ordered[i - 1]!
    const cur = ordered[i]!
    const next = ordered[i + 1]!
    const d1 = haversineKm(
      { lat: prev.lat!, lon: prev.lon! },
      { lat: cur.lat!, lon: cur.lon! },
    )
    const d2 = haversineKm(
      { lat: cur.lat!, lon: cur.lon! },
      { lat: next.lat!, lon: next.lon! },
    )
    if (d1 > maxWalkKm * 2 && d2 < maxWalkKm * 0.5) score += 1.5
  }

  if (kinds.includes('cafe') && kinds.indexOf('cafe') > n / 2) {
    summaryParts.push('moved café earlier')
  }
  if (kinds.includes('dinner') && kinds.lastIndexOf('dinner') < n / 2) {
    summaryParts.push('dinner later')
  }
  if (walkOver) {
    summaryParts.push(
      `${walkOver} hop${walkOver === 1 ? '' : 's'} over ${maxWalkKm} km (drive/transit)`,
    )
  }
  summaryParts.push(`~${Math.round(totalKm * 10) / 10} km path`)

  return { score, summaryParts }
}

function nearestNeighbor(
  places: PlanPlace[],
  startIdx: number,
): PlanPlace[] {
  const remaining = [...places]
  const ordered: PlanPlace[] = [remaining.splice(startIdx, 1)[0]!]
  while (remaining.length) {
    const last = ordered[ordered.length - 1]!
    let bestIdx = 0
    let bestD = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!
      const d = haversineKm(
        { lat: last.lat!, lon: last.lon! },
        { lat: cand.lat!, lon: cand.lon! },
      )
      if (d < bestD) {
        bestD = d
        bestIdx = i
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]!)
  }
  return ordered
}

function mealAwareOrder(places: PlanPlace[]): PlanPlace[] {
  const cafes = places.filter((p) => classifyPlanPlace(p) === 'cafe')
  const lunches = places.filter((p) => classifyPlanPlace(p) === 'lunch')
  const dinners = places.filter((p) => classifyPlanPlace(p) === 'dinner')
  const rest = places.filter((p) => {
    const k = classifyPlanPlace(p)
    return k !== 'cafe' && k !== 'lunch' && k !== 'dinner'
  })
  // Greedy NN on non-meals, then insert meals at arc positions
  let core =
    rest.length >= 2 ? nearestNeighbor(rest, 0) : [...rest]
  if (cafes[0]) core = [cafes[0], ...core]
  if (lunches[0]) {
    const mid = Math.max(1, Math.floor(core.length / 2))
    core = [...core.slice(0, mid), lunches[0], ...core.slice(mid)]
  }
  for (const d of dinners) core = [...core, d]
  // Append leftover meals
  for (const c of cafes.slice(1)) {
    if (!core.includes(c)) core = [c, ...core]
  }
  for (const l of lunches.slice(1)) {
    if (!core.includes(l)) core.splice(Math.floor(core.length / 2), 0, l)
  }
  return core
}

function dayHotelAnchor(
  trip: TripRecord,
  day: string,
): { lat: number; lon: number } | null {
  const hotel = trip.items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      itemTouchesDay(i, day) &&
      isValidCoord(i.lat, i.lon),
  )
  if (hotel) return { lat: hotel.lat!, lon: hotel.lon! }
  const base = trip.items.find(
    (i) =>
      isPlaceholderBase(i) &&
      itemTouchesDay(i, day) &&
      isValidCoord(i.lat, i.lon),
  )
  if (base) return { lat: base.lat!, lon: base.lon! }
  return null
}

/**
 * Optimize a Plan day order. Returns result + apply via reorderDayPlaces.
 */
export function optimizePlanDay(
  trip: TripRecord,
  day: string,
): PlanOptimizeResult {
  const dayPlaces = trip.planPlaces
    .filter((p) => p.scheduledDay === day && isValidCoord(p.lat, p.lon))
    .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))

  if (dayPlaces.length < 2) {
    return {
      kind: 'reorder',
      day,
      orderedIds: dayPlaces.map((p) => p.id),
      summary: 'Need at least 2 pinned places to optimize.',
      pace: 'easy',
    }
  }

  const prefs = prefsFromMeta(trip)
  const maxWalkKm = prefs.maxWalkKm ?? 1.5
  const hotel = dayHotelAnchor(trip, day)

  const candidates: Array<{
    pace: 'easy' | 'packed'
    ordered: PlanPlace[]
  }> = [
    { pace: 'easy', ordered: mealAwareOrder(dayPlaces) },
    { pace: 'packed', ordered: nearestNeighbor(dayPlaces, 0) },
  ]
  if (dayPlaces.length >= 3) {
    candidates.push({
      pace: 'packed',
      ordered: nearestNeighbor(dayPlaces, dayPlaces.length - 1),
    })
  }

  let best = candidates[0]!
  let bestScore = Infinity
  let bestParts: string[] = []
  const scored: PlanOptimizeResult['alternatives'] = []

  for (const c of candidates) {
    // Ensure all ids present
    const ids = new Set(c.ordered.map((p) => p.id))
    const missing = dayPlaces.filter((p) => !ids.has(p.id))
    const full = [...c.ordered, ...missing]
    const { score, summaryParts } = scoreOrder(full, maxWalkKm, hotel)
    scored.push({
      pace: c.pace,
      orderedIds: full.map((p) => p.id),
      summary: summaryParts.join(' · ') || 'Reordered day',
    })
    if (score < bestScore) {
      bestScore = score
      best = { pace: c.pace, ordered: full }
      bestParts = summaryParts
    }
  }

  const alts = scored
    .filter((a) => a.orderedIds.join() !== best.ordered.map((p) => p.id).join())
    .slice(0, 2)

  return {
    kind: 'reorder',
    day,
    orderedIds: best.ordered.map((p) => p.id),
    summary: bestParts.join(' · ') || 'Meal arc + shorter hops',
    pace: best.pace === 'easy' ? 'easy' : 'packed',
    alternatives: alts.length ? alts : undefined,
  }
}

export function applyPlanOptimize(
  trip: TripRecord,
  result: PlanOptimizeResult,
): TripRecord {
  if (result.orderedIds.length < 2) return trip
  return reorderDayPlaces(trip, result.day, result.orderedIds)
}

/** Drop-in replacement for greedy optimizeDayRoute. */
export function optimizeDayRouteSmart(
  trip: TripRecord,
  day: string,
): TripRecord {
  return applyPlanOptimize(trip, optimizePlanDay(trip, day))
}
