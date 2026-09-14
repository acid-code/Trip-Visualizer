/** Day Coach: diagnose day, gather POIs, Gemini + local variant bank. */

import type { TripItem, TripMeta, TripRecord } from '../domain/types'
import { isPlaceholderBase, itemTouchesDay } from './dayBases'
import {
  explorePlaceToItemType,
  fetchNearbyExplore,
  type ExplorePlace,
} from './explore'
import { isValidCoord } from './validate'
import { logClientError } from './security'
import {
  acceptPlaceForTime,
  placeOpenStatus,
  summarizeOpenSlots,
} from './openingHours'
import type {
  AiCoachApiResponse,
  AiCoachCandidate,
  AiCoachDayItem,
  AiCoachOption,
  AiCoachOptionKind,
  AiCoachRequestBody,
} from './aiCoachTypes'

const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)$/

export type CoachIntent = {
  fill: boolean
  fun: boolean
  drive: boolean
  food: boolean
  views: boolean
  trim: boolean
  pace: boolean
  latePub: boolean
  generic: boolean
}

export type DayDiagnosis = {
  fillLevel: 'empty' | 'partial' | 'full'
  mealGaps: { morning: boolean; lunch: boolean; dinner: boolean }
  hasVehicle: boolean
  hasDrive: boolean
  sightCount: number
  restaurantCount: number
  cluster: 'near_start' | 'already_away'
  overload: boolean
  removableIds: string[]
}

export function dayItemsForCoach(items: TripItem[], day: string): TripItem[] {
  return items.filter((i) => itemTouchesDay(i, day))
}

function isVehicleStop(item: TripItem): boolean {
  return /dealer|dealership|rental|rent-a-car|avis|hertz|sixt|europcar|enterprise|car\s*hire|pick\s*up|car\s*pickup/i.test(
    `${item.title} ${item.place} ${item.notes}`,
  )
}

export function dayFillLevel(
  items: TripItem[],
  day: string,
): 'empty' | 'partial' | 'full' {
  const dayItems = dayItemsForCoach(items, day).filter(
    (i) => i.status !== 'cancelled' && !isPlaceholderBase(i) && i.type !== 'note',
  )
  const content = dayItems.filter(
    (i) =>
      ['sight', 'restaurant', 'activity', 'city', 'other'].includes(i.type) &&
      !isVehicleStop(i),
  )
  const skeletonOnly =
    dayItems.length > 0 &&
    dayItems.every(
      (i) =>
        i.type === 'hotel' ||
        i.type === 'flight' ||
        i.type === 'train' ||
        i.type === 'bus' ||
        i.type === 'ferry' ||
        isVehicleStop(i) ||
        i.type === 'drive',
    )
  if (content.length === 0 || skeletonOnly) return 'empty'
  if (content.length >= 5) return 'full'
  return 'partial'
}

export function isThinDay(items: TripItem[], day: string): boolean {
  return dayFillLevel(items, day) === 'empty'
}

export function detectCoachIntent(userMessage: string): CoachIntent {
  const m = userMessage.toLowerCase()
  const fill = /fill|plan\s*(the\s*)?day|day\s*plan|itinerary|full\s*day|empty\s*day|what\s*to\s*do/i.test(
    m,
  )
  const fun =
    /fun|activit|sight|museum|hike|walk|explore|thing to do|things to do|something to do|must.?see|highlight|attraction/i.test(
      m,
    )
  const drive =
    /drive|car|road\s*trip|scenic|provence|countryside|day\s*trip|take the car|luberon|tuscany|amalfi/i.test(
      m,
    )
  const food =
    /eat|food|lunch|dinner|breakfast|restaurant|nice\s*meal|cuisine|caf[eé]|coffee|romantic|pub|bar/i.test(
      m,
    )
  const views = /view|lookout|panorama|belvedere|viewpoint|scenic\s*stop|pit\s*stop/i.test(
    m,
  )
  const trim = /remove|trim|lighten|simplify|too much|busy|cut|drop|less/i.test(m)
  const pace = /pace|retim|schedule|time|spread|breath|loosen|gap/i.test(m)
  const latePub =
    /after\s*dinner|another\s*pub|nightcap|late\s*drink|drinks?\s*after|second\s*pub|bar\s*after/i.test(
      m,
    )
  const generic =
    !fill &&
    !fun &&
    !drive &&
    !food &&
    !views &&
    !trim &&
    !pace &&
    (/help|improve|suggest|idea|option|recommend|anything|something|^$/i.test(m) ||
      m.trim().length < 12)
  return { fill, fun, drive, food, views, trim, pace, latePub, generic }
}

export function diagnoseDay(
  items: TripItem[],
  day: string,
  anchor: { lat: number; lon: number } | null,
): DayDiagnosis {
  const fillLevel = dayFillLevel(items, day)
  const dayItems = dayItemsForCoach(items, day).filter(
    (i) => i.status !== 'cancelled' && !isPlaceholderBase(i),
  )
  const content = dayItems.filter(
    (i) =>
      ['sight', 'restaurant', 'activity', 'city', 'other'].includes(i.type) &&
      !isVehicleStop(i),
  )
  const restaurants = content.filter((i) => i.type === 'restaurant')
  const sights = content.filter(
    (i) => i.type === 'sight' || i.type === 'activity',
  )
  const hasMorning = restaurants.some(
    (i) => i.start && i.start < '11:00',
  )
  const hasLunch = restaurants.some(
    (i) => i.start && i.start >= '11:30' && i.start < '16:00',
  )
  const hasDinner = restaurants.some(
    (i) => i.start && i.start >= '18:00',
  )
  const removable = content.filter((i) =>
    ['sight', 'restaurant', 'activity', 'note', 'other'].includes(i.type),
  )
  let cluster: 'near_start' | 'already_away' = 'near_start'
  if (anchor) {
    const far = content.filter((i) => {
      if (!isValidCoord(i.lat, i.lon)) return false
      return awaitableDist(anchor, { lat: i.lat!, lon: i.lon! }).distKm >= 8
    })
    if (far.length >= 2) cluster = 'already_away'
  }
  const timed = content.filter((i) => i.start)
  const overload =
    content.length >= 5 ||
    (timed.length >= 4 &&
      timed.some((a, idx) => {
        const b = timed[idx + 1]
        if (!b || !a.start || !b.start) return false
        return timeToMin(b.start) - timeToMin(a.start) < 45
      }))

  return {
    fillLevel,
    mealGaps: {
      morning: !hasMorning,
      lunch: !hasLunch,
      dinner: !hasDinner,
    },
    hasVehicle: dayItems.some(isVehicleStop),
    hasDrive: dayItems.some((i) => i.type === 'drive'),
    sightCount: sights.length,
    restaurantCount: restaurants.length,
    cluster,
    overload,
    removableIds: removable.map((i) => i.id),
  }
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function placeBlob(p: ExplorePlace): string {
  return `${p.name} ${p.cuisine} ${p.summary} ${p.address}`.toLowerCase()
}

function isCafePlace(p: ExplorePlace): boolean {
  const b = placeBlob(p)
  return (
    /caf[eé]|coffee|espresso|bakery|breakfast|brunch|tea\s*room/.test(b) ||
    (p.category === 'food' && /cafe|coffee/.test(b))
  )
}

function isPubPlace(p: ExplorePlace): boolean {
  const b = placeBlob(p)
  return (
    p.category === 'drink' ||
    /pub|bar|biergarten|tavern|brewery|wine\s*bar/.test(b)
  )
}

function isDinnerPlace(p: ExplorePlace): boolean {
  if (p.category !== 'food' && p.category !== 'drink') return false
  if (isCafePlace(p)) return false
  return true
}

function rankFood(a: ExplorePlace, b: ExplorePlace): number {
  return (b.rating ?? 0) - (a.rating ?? 0) || a.distKm - b.distKm
}

function rankSight(a: ExplorePlace, b: ExplorePlace): number {
  return (b.rating ?? 0) - (a.rating ?? 0) || a.distKm - b.distKm
}

/** Prefer hotel / day-base, else arrival transit `to`, else first coord on the day. */
export function resolveDayAnchor(
  items: TripItem[],
  day: string,
): { lat: number; lon: number; label: string } | null {
  const dayItems = dayItemsForCoach(items, day)

  const hotel = dayItems.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      isValidCoord(i.lat, i.lon),
  )
  if (hotel) {
    return {
      lat: hotel.lat!,
      lon: hotel.lon!,
      label: hotel.title || hotel.place || 'Hotel',
    }
  }

  const base = dayItems.find(
    (i) => isPlaceholderBase(i) && isValidCoord(i.lat, i.lon),
  )
  if (base) {
    return {
      lat: base.lat!,
      lon: base.lon!,
      label: base.title || 'Day base',
    }
  }

  const transit = dayItems.find(
    (i) =>
      (i.type === 'flight' ||
        i.type === 'train' ||
        i.type === 'bus' ||
        i.type === 'ferry') &&
      isValidCoord(i.latTo, i.lonTo),
  )
  if (transit) {
    return {
      lat: transit.latTo!,
      lon: transit.lonTo!,
      label: transit.to || transit.title || 'Arrival',
    }
  }

  for (const i of dayItems) {
    if (isValidCoord(i.lat, i.lon)) {
      return { lat: i.lat!, lon: i.lon!, label: i.title || i.place || 'Stop' }
    }
    if (isValidCoord(i.latTo, i.lonTo)) {
      return {
        lat: i.latTo!,
        lon: i.lonTo!,
        label: i.to || i.title || 'Stop',
      }
    }
  }
  return null
}

function trimCandidate(
  p: ExplorePlace,
  extras?: {
    role?: AiCoachCandidate['role']
    regionLabel?: string
    day?: string
  },
): AiCoachCandidate {
  const role =
    extras?.role ??
    (p.category === 'food' || p.category === 'drink'
      ? 'meal'
      : /view|lookout|panorama|belvedere|viewpoint/i.test(p.name + p.summary)
        ? 'viewpoint'
        : p.distKm >= 12
          ? 'destination'
          : p.distKm >= 4
            ? 'along_route'
            : 'near_start')
  const day = extras?.day
  const openHint = day
    ? summarizeOpenSlots(day, p.openingPeriods, p.openingHours)
    : ''
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    lat: p.lat,
    lon: p.lon,
    distKm: Math.round(p.distKm * 10) / 10,
    rating: p.rating,
    summary: (p.summary || '').slice(0, 280),
    address: (p.address || '').slice(0, 200),
    cuisine: (p.cuisine || '').slice(0, 80),
    role,
    regionLabel: extras?.regionLabel,
    openingHours: (p.openingHours || '').slice(0, 280) || undefined,
    openHint: openHint || undefined,
  }
}

function placeOpenFor(
  p: ExplorePlace,
  day: string,
  timeHM?: string | null,
): boolean {
  return acceptPlaceForTime({
    dateISO: day,
    timeHM,
    periods: p.openingPeriods,
    openingHours: p.openingHours,
  })
}

/** Prefer places known open at time; drop known-closed. */
function preferOpenAt(
  list: ExplorePlace[],
  day: string,
  timeHM: string,
): ExplorePlace[] {
  const open: ExplorePlace[] = []
  const unknown: ExplorePlace[] = []
  for (const p of list) {
    const st = placeOpenStatus({
      dateISO: day,
      timeHM,
      periods: p.openingPeriods,
      openingHours: p.openingHours,
    })
    if (st === 'closed') continue
    if (st === 'open') open.push(p)
    else unknown.push(p)
  }
  return open.length ? [...open, ...unknown] : unknown.length ? unknown : list
}

function mergePlaces(into: Map<string, ExplorePlace>, list: ExplorePlace[]) {
  for (const p of list) {
    if (!into.has(p.id)) into.set(p.id, p)
  }
}

function sampleDrivePoints(
  item: TripItem,
  max = 3,
): Array<{ lat: number; lon: number }> {
  const coords = item.routeCoords
  if (!coords?.length) {
    if (
      isValidCoord(item.lat, item.lon) &&
      isValidCoord(item.latTo, item.lonTo)
    ) {
      return [
        {
          lat: (item.lat! + item.latTo!) / 2,
          lon: (item.lon! + item.lonTo!) / 2,
        },
      ]
    }
    return []
  }
  if (coords.length <= max) {
    return coords.map(([lat, lon]) => ({ lat, lon }))
  }
  const out: Array<{ lat: number; lon: number }> = []
  for (let i = 1; i <= max; i++) {
    const idx = Math.floor((i / (max + 1)) * (coords.length - 1))
    const c = coords[idx]!
    out.push({ lat: c[0], lon: c[1] })
  }
  return out
}

function regionSearchQueries(userMessage: string): string[] {
  const m = userMessage.toLowerCase()
  if (/provence|provençal|luberon|aix|avignon|cassis|calanques/.test(m)) {
    return [
      'Luberon, Provence, France',
      'Aix-en-Provence, France',
      'Gordes Provence viewpoint',
    ]
  }
  if (/tuscany|chianti|siena|florence/.test(m)) {
    return ['Chianti, Tuscany, Italy', 'San Gimignano viewpoint']
  }
  if (/amalfi|positano|sorrento/.test(m)) {
    return ['Amalfi Coast, Italy', 'Positano viewpoint']
  }
  return []
}

async function resolveRegionAnchors(
  userMessage: string,
  bias: { lat: number; lon: number } | null,
  opts?: {
    signal?: AbortSignal
    useGooglePlaces?: boolean
    googleApiKey?: string
  },
): Promise<Array<{ lat: number; lon: number; label: string }>> {
  const out: Array<{ lat: number; lon: number; label: string }> = []
  const queries = regionSearchQueries(userMessage)

  for (const q of queries.slice(0, 2)) {
    if (opts?.signal?.aborted) break
    if (opts?.useGooglePlaces) {
      try {
        const { fetchGoogleTextViaProxy } = await import('./placesGoogle')
        const hit = await fetchGoogleTextViaProxy({
          query: q,
          apiKey: opts.googleApiKey,
          bias: bias ? { ...bias, radiusM: 80_000 } : undefined,
          signal: opts.signal,
        })
        if (hit && isValidCoord(hit.lat, hit.lon)) {
          out.push({ lat: hit.lat, lon: hit.lon, label: hit.name || q })
          continue
        }
      } catch (err) {
        logClientError('ai-coach-region-google', err)
      }
    }
    try {
      const { geocodePlace } = await import('./enrichment')
      const g = await geocodePlace(q)
      if (g) out.push({ lat: g.lat, lon: g.lon, label: q })
    } catch (err) {
      logClientError('ai-coach-region-geocode', err)
    }
  }

  if (!out.length && detectCoachIntent(userMessage).drive && bias) {
    out.push({
      lat: bias.lat + 0.32,
      lon: bias.lon - 0.22,
      label: 'Day-trip area inland',
    })
  }

  if (!out.length) {
    const m = userMessage.toLowerCase()
    const fallback =
      /provence|provençal|luberon/.test(m)
        ? 'Provence, France'
        : /tuscany|chianti/.test(m)
          ? 'Tuscany, Italy'
          : /amalfi/.test(m)
            ? 'Amalfi Coast, Italy'
            : null
    if (fallback) {
      try {
        const { geocodePlace } = await import('./enrichment')
        const g = await geocodePlace(fallback)
        if (g) out.push({ lat: g.lat, lon: g.lon, label: fallback })
      } catch (err) {
        logClientError('ai-coach-region-fallback', err)
      }
    }
  }
  return out
}

function buildPlanningHints(
  items: TripItem[],
  day: string,
  _userMessage: string,
  diagnosis: DayDiagnosis,
  intent: CoachIntent,
): string[] {
  const hints: string[] = []
  const dayItems = dayItemsForCoach(items, day).filter((i) => !isPlaceholderBase(i))

  hints.push(
    `Day diagnosis: fillLevel=${diagnosis.fillLevel}, sights=${diagnosis.sightCount}, restaurants=${diagnosis.restaurantCount}, cluster=${diagnosis.cluster}, overload=${diagnosis.overload}, mealGaps morning/lunch/dinner=${diagnosis.mealGaps.morning}/${diagnosis.mealGaps.lunch}/${diagnosis.mealGaps.dinner}.`,
  )
  hints.push(
    `Intent tags: ${Object.entries(intent)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ') || 'generic'}.`,
  )

  if (diagnosis.fillLevel === 'empty') {
    hints.push(
      'Empty/skeleton day: help fill THIS day. Prefer a full-day itinerary with café + fun sight + lunch + dinner when asked to fill/plan/fun.',
    )
  } else if (diagnosis.fillLevel === 'partial') {
    hints.push(
      'Partly filled: offer 3 light alternative tweaks — do NOT rebuild the whole day.',
    )
  } else {
    hints.push(
      'Full day: offer trim, one quality upgrade, and pacing — not a new full itinerary.',
    )
  }

  if (intent.drive && diagnosis.fillLevel === 'empty') {
    hints.push(
      'Empty drive day: addDrives + viewpoint + destination + meals. Prefer destination/along_route over airport food.',
    )
  }
  if (intent.fun || intent.fill) {
    hints.push(
      'Fill/fun: include sights or nature — never only a morning café. Activity ≠ restaurant.',
    )
  }
  if (intent.food) {
    hints.push(
      'Food: café ~09:00, lunch ~13:00, dinner/pub ~19:30 near where they will be.',
    )
  }
  if (intent.latePub) {
    hints.push('Add a pub/bar after dinner (~21:00) only as an extra stop.')
  }
  if (intent.trim || diagnosis.overload) {
    const removable = dayItems.filter(
      (i) =>
        !isPlaceholderBase(i) &&
        !isVehicleStop(i) &&
        ['sight', 'restaurant', 'activity', 'note', 'other', 'city'].includes(
          i.type,
        ),
    )
    const n = diagnosis.overload || intent.trim ? Math.min(4, Math.max(2, removable.length - 1)) : 2
    hints.push(
      `Include a trim option removing ${n} weaker content stops (use exact dayItems.id where canRemove=true). List: ${removable
        .slice(0, 8)
        .map((i) => `${i.title}→${i.id}`)
        .join('; ') || 'none'}.`,
    )
  }
  if (intent.pace) {
    hints.push('Include a pacing option that spreads setTimes on this day.')
  }

  const vehicle = dayItems.find(isVehicleStop)
  if (vehicle) {
    hints.push(
      `Vehicle stop: “${vehicle.title}” (${vehicle.id}) — start drives from there.`,
    )
  }
  if (diagnosis.cluster === 'already_away') {
    hints.push('Traveler already has stops away from start — place new food near those.')
  }
  hints.push(
    'Respect candidate openHint/openingHours for the coached day: never schedule a stop when that place is closed at the suggested start time. Prefer candidates marked open at café(~09:00)/lunch(~13:00)/dinner(~19:30) slots.',
  )
  hints.push(
    'When clarifications include Original request / Coach asked / User replied, resolve short answers like “first one” against Coach asked, then return options — do not re-ask.',
  )
  hints.push(
    'Return 1–3 solid options (quality over quantity). One strong option is fine.',
  )
  return hints
}

function awaitableDist(
  anchor: { lat: number; lon: number },
  p: { lat: number; lon: number },
) {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(p.lat - anchor.lat)
  const dLon = toRad(p.lon - anchor.lon)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(anchor.lat)) *
      Math.cos(toRad(p.lat)) *
      Math.sin(dLon / 2) ** 2
  return { distKm: 2 * R * Math.asin(Math.min(1, Math.sqrt(a))) }
}

/** Fetch nearby + destination-region POIs for the coached day. */
export async function gatherCoachCandidates(
  trip: TripRecord,
  day: string,
  opts?: {
    signal?: AbortSignal
    useGooglePlaces?: boolean
    googleApiKey?: string
    userMessage?: string
  },
): Promise<ExplorePlace[]> {
  const items = trip.items
  const anchor = resolveDayAnchor(items, day)
  const byId = new Map<string, ExplorePlace>()
  const msg = opts?.userMessage || ''
  const intent = detectCoachIntent(msg)
  const fill = dayFillLevel(items, day)
  const coachCats = ['food', 'drink', 'sights', 'nature'] as const

  const nearRadius =
    intent.fun || intent.fill || fill === 'empty' ? 2800 : 1800
  const nearLimit =
    intent.fun || intent.fill || fill === 'empty' ? 28 : 16
  const regionLimit = intent.drive || intent.fill ? 32 : 24

  async function safeExplore(
    point: { lat: number; lon: number },
    radiusM: number,
    limit: number,
    categories?: ExplorePlace['category'][],
  ) {
    try {
      return await fetchNearbyExplore(point, {
        radiusM,
        limit,
        signal: opts?.signal,
        useGooglePlaces: opts?.useGooglePlaces,
        googleApiKey: opts?.googleApiKey,
        refreshInBackground: false,
        categories: categories?.length ? categories : [...coachCats],
      })
    } catch (err) {
      if (opts?.signal?.aborted) throw err
      logClientError('ai-coach-explore', err)
      return [] as ExplorePlace[]
    }
  }

  if (anchor) {
    mergePlaces(byId, await safeExplore(anchor, nearRadius, nearLimit))
    if (intent.fun || intent.fill || fill === 'empty') {
      mergePlaces(
        byId,
        await safeExplore(anchor, 3500, 20, ['sights', 'nature']),
      )
    }
    if (intent.food || intent.latePub || fill === 'empty') {
      mergePlaces(
        byId,
        await safeExplore(anchor, 2200, 16, ['food', 'drink']),
      )
    }
  }

  const regions = await resolveRegionAnchors(
    msg,
    anchor ? { lat: anchor.lat, lon: anchor.lon } : null,
    opts,
  )
  for (const region of regions) {
    if (opts?.signal?.aborted) break
    const found = await safeExplore(region, 5500, regionLimit)
    const adjusted = found.map((p) => {
      if (!anchor) return p
      return { ...p, distKm: awaitableDist(anchor, p).distKm }
    })
    mergePlaces(byId, adjusted)
  }

  const drives = dayItemsForCoach(items, day).filter((i) => i.type === 'drive')
  const drive = drives[0]
  if (drive && !opts?.signal?.aborted) {
    const mid = sampleDrivePoints(drive, 1)[0]
    if (mid) {
      mergePlaces(
        byId,
        (
          await safeExplore(mid, intent.views ? 2000 : 1500, 14, [
            'sights',
            'nature',
            'food',
          ])
        ).filter(
          (p) =>
            p.category === 'sights' ||
            p.category === 'nature' ||
            p.category === 'food',
        ),
      )
    }
  }

  const list = [...byId.values()]
  if (anchor) {
    for (const p of list) {
      p.distKm = awaitableDist(anchor, p).distKm
    }
  }

  const usable = list.filter((p) => {
    if (p.category === 'hotel') return false
    const hint = summarizeOpenSlots(day, p.openingPeriods, p.openingHours)
    return hint !== 'closed all typical slots'
  })
  const ranked = usable.length ? usable : list.filter((p) => p.category !== 'hotel')

  // Prefer sights earlier in the list for fun/fill so Gemini sees them
  if (intent.fun || intent.fill) {
    ranked.sort((a, b) => {
      const as =
        a.category === 'sights' || a.category === 'nature' ? 0 : 1
      const bs =
        b.category === 'sights' || b.category === 'nature' ? 0 : 1
      return as - bs || a.distKm - b.distKm
    })
  } else {
    ranked.sort((a, b) => a.distKm - b.distKm)
  }
  return ranked.slice(0, 56)
}

export function buildCoachRequestBody(args: {
  trip: TripRecord
  day: string
  userMessage: string
  clarifications: string[]
  candidates: ExplorePlace[]
}): AiCoachRequestBody {
  const { trip, day, userMessage, clarifications, candidates } = args
  const dayItems = dayItemsForCoach(trip.items, day)
  const anchor = resolveDayAnchor(trip.items, day)
  const diagnosis = diagnoseDay(trip.items, day, anchor)
  const intent = detectCoachIntent(userMessage)

  const trimmed: AiCoachDayItem[] = dayItems.map((i) => {
    const placeholder = isPlaceholderBase(i)
    const vehicle = isVehicleStop(i)
    const canRemove =
      !placeholder &&
      !vehicle &&
      ['sight', 'restaurant', 'activity', 'note', 'other', 'city', 'drive'].includes(
        i.type,
      )
    return {
      id: i.id,
      type: i.type,
      title: i.title,
      place: i.place,
      date: i.date,
      start: i.start,
      end: i.end,
      lat: i.lat,
      lon: i.lon,
      latTo: i.latTo,
      lonTo: i.lonTo,
      isPlaceholder: placeholder,
      isVehicleStop: vehicle,
      canRemove,
    }
  })

  const tagged = candidates.map((p) => {
    const viewish = /view|lookout|panorama|belvedere|viewpoint|scenic/i.test(
      p.name + p.summary,
    )
    let role: AiCoachCandidate['role'] = 'near_start'
    if (viewish && p.distKm >= 3) role = 'viewpoint'
    else if (p.category === 'food' || p.category === 'drink') {
      role = p.distKm >= 5 ? 'meal' : 'near_start'
    } else if (p.distKm >= 12) role = 'destination'
    else if (p.distKm >= 4) role = 'along_route'
    return trimCandidate(p, {
      role,
      regionLabel: p.distKm >= 8 ? 'farther day-trip area' : undefined,
      day,
    })
  })

  return {
    day,
    userMessage: userMessage.slice(0, 2000),
    clarifications: clarifications.map((c) => c.slice(0, 500)).slice(0, 12),
    tripName: trip.meta.name,
    travelers: trip.meta.travelers,
    notes: trip.meta.notes.slice(0, 1500),
    thinDay: diagnosis.fillLevel === 'empty',
    dayFillLevel: diagnosis.fillLevel,
    anchor,
    dayItems: trimmed,
    candidates: tagged,
    planningHints: buildPlanningHints(
      trip.items,
      day,
      userMessage,
      diagnosis,
      intent,
    ),
  }
}

function sanitizeTime(t: unknown): string | undefined {
  const s = String(t ?? '').trim()
  return TIME_HM.test(s) ? s : undefined
}

function isRemovableDayItem(i: AiCoachDayItem): boolean {
  if (i.isPlaceholder || i.isVehicleStop) return false
  if (i.canRemove === false) return false
  if (i.canRemove === true) return true
  return ['sight', 'restaurant', 'activity', 'note', 'other', 'city', 'drive'].includes(
    i.type,
  )
}

function resolveRemovableItemId(
  dayItems: AiCoachDayItem[],
  rawId: string,
  rawTitle?: string,
): string | null {
  const itemId = rawId.trim()
  if (itemId) {
    const byId = dayItems.find((d) => d.id === itemId)
    if (byId && isRemovableDayItem(byId)) return byId.id
  }
  const title = (rawTitle || itemId).trim().toLowerCase()
  if (!title || title.length < 3) return null
  const hit = dayItems.find((d) => {
    if (!isRemovableDayItem(d)) return false
    const blob = `${d.title} ${d.place}`.toLowerCase()
    return (
      blob === title ||
      blob.includes(title) ||
      (d.title.length >= 3 && title.includes(d.title.toLowerCase()))
    )
  })
  return hit?.id ?? null
}

function sanitizeOption(
  raw: unknown,
  candidateIds: Set<string>,
  dayItems: AiCoachDayItem[],
  candidates: ExplorePlace[],
  day: string,
): AiCoachOption | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = String(o.id ?? '').trim().slice(0, 64)
  const label = String(o.label ?? '').trim().slice(0, 80)
  if (!id || !label) return null
  const kindRaw = String(o.kind ?? 'other')
  const kind: AiCoachOptionKind =
    kindRaw === 'food' ||
    kindRaw === 'highlight' ||
    kindRaw === 'viewpoint' ||
    kindRaw === 'pacing' ||
    kindRaw === 'itinerary' ||
    kindRaw === 'trim' ||
    kindRaw === 'other'
      ? kindRaw
      : 'other'

  const dayItemIds = new Set(dayItems.map((i) => i.id))
  const byCandidate = new Map(candidates.map((c) => [c.id, c]))

  const patchRaw =
    o.patch && typeof o.patch === 'object'
      ? (o.patch as Record<string, unknown>)
      : {}

  const addStepsIn = Array.isArray(patchRaw.addSteps) ? patchRaw.addSteps : []
  const addSteps = addStepsIn
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const candidateId = String(r.candidateId ?? '').trim()
      if (!candidateIds.has(candidateId)) return null
      const place = byCandidate.get(candidateId)
      if (place?.category === 'hotel') return null
      const start = sanitizeTime(r.start)
      if (place && !placeOpenFor(place, day, start || '12:00')) return null
      return {
        candidateId,
        start,
        end: sanitizeTime(r.end),
        note: String(r.note ?? '').trim().slice(0, 400) || undefined,
      }
    })
    .filter(Boolean) as NonNullable<AiCoachOption['patch']['addSteps']>

  const addDrivesIn = Array.isArray(patchRaw.addDrives) ? patchRaw.addDrives : []
  const addDrives = addDrivesIn
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const toCandidateId = String(r.toCandidateId ?? '').trim()
      if (!candidateIds.has(toCandidateId)) return null
      const place = byCandidate.get(toCandidateId)
      const start = sanitizeTime(r.start)
      const end = sanitizeTime(r.end)
      // Destination must be open around arrival (end) or departure+visit
      if (
        place &&
        !placeOpenFor(place, day, end || start || '12:00')
      ) {
        return null
      }
      const fromItemId = String(r.fromItemId ?? '').trim()
      return {
        toCandidateId,
        fromItemId:
          fromItemId && dayItemIds.has(fromItemId) ? fromItemId : undefined,
        start,
        end,
      }
    })
    .filter(Boolean) as NonNullable<AiCoachOption['patch']['addDrives']>

  const setTimesIn = Array.isArray(patchRaw.setTimes) ? patchRaw.setTimes : []
  const setTimes = setTimesIn
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const itemId = String(r.itemId ?? '').trim()
      if (!itemId || !dayItemIds.has(itemId)) return null
      return {
        itemId,
        start: sanitizeTime(r.start),
        end: sanitizeTime(r.end),
      }
    })
    .filter(Boolean) as NonNullable<AiCoachOption['patch']['setTimes']>

  const removeIn = Array.isArray(patchRaw.removeSteps) ? patchRaw.removeSteps : []
  const seenRemove = new Set<string>()
  const removeSteps = removeIn
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const r = row as Record<string, unknown>
      const resolved = resolveRemovableItemId(
        dayItems,
        String(r.itemId ?? r.id ?? ''),
        String(r.title ?? r.name ?? ''),
      )
      if (!resolved || seenRemove.has(resolved)) return null
      seenRemove.add(resolved)
      return { itemId: resolved }
    })
    .filter(Boolean) as NonNullable<AiCoachOption['patch']['removeSteps']>

  let addNote: AiCoachOption['patch']['addNote']
  if (patchRaw.addNote && typeof patchRaw.addNote === 'object') {
    const n = patchRaw.addNote as Record<string, unknown>
    const title = String(n.title ?? '').trim().slice(0, 120)
    const notes = String(n.notes ?? '').trim().slice(0, 800)
    if (title) {
      addNote = { title, notes, start: sanitizeTime(n.start) }
    }
  }

  const hasAction =
    addSteps.length ||
    addDrives.length ||
    setTimes.length ||
    removeSteps.length ||
    addNote
  if (!hasAction) return null

  return {
    id,
    label,
    kind,
    summary: String(o.summary ?? '').trim().slice(0, 240),
    rationale: String(o.rationale ?? '').trim().slice(0, 600),
    patch: { addSteps, addDrives, setTimes, removeSteps, addNote },
  }
}

export function parseCoachResponse(
  data: unknown,
  candidates: ExplorePlace[],
  dayItems?: AiCoachDayItem[],
  day?: string,
): AiCoachApiResponse {
  const candidateIds = new Set(candidates.map((c) => c.id))
  const items = dayItems ?? []
  const coachDay = day || ''
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid coach response')
  }
  const d = data as Record<string, unknown>
  if (d.kind === 'need_clarification') {
    const question = String(d.question ?? '').trim().slice(0, 400)
    if (!question) throw new Error('Empty clarification')
    return { kind: 'need_clarification', question }
  }
  if (d.kind === 'options') {
    const rawOpts = Array.isArray(d.options) ? d.options : []
    const options = rawOpts
      .map((o) => sanitizeOption(o, candidateIds, items, candidates, coachDay))
      .filter(Boolean) as AiCoachOption[]
    if (!options.length) throw new Error('No grounded options')
    return { kind: 'options', options: options.slice(0, 5) }
  }
  throw new Error('Unknown coach response kind')
}

function patchFingerprint(o: AiCoachOption): string {
  const p = o.patch
  return JSON.stringify({
    k: o.kind,
    a: (p.addSteps ?? []).map((s) => s.candidateId).sort(),
    d: (p.addDrives ?? []).map((s) => s.toCandidateId).sort(),
    r: (p.removeSteps ?? []).map((s) => s.itemId).sort(),
    t: (p.setTimes ?? []).map((s) => s.itemId).sort(),
  })
}

function dedupeOptions(options: AiCoachOption[]): AiCoachOption[] {
  const seenId = new Set<string>()
  const seenFp = new Set<string>()
  const out: AiCoachOption[] = []
  for (const o of options) {
    const fp = patchFingerprint(o)
    if (seenId.has(o.id) || seenFp.has(fp)) continue
    seenId.add(o.id)
    seenFp.add(fp)
    out.push(o)
  }
  return out
}

function diversifyByKind(options: AiCoachOption[], max: number): AiCoachOption[] {
  const byKind = new Map<string, AiCoachOption[]>()
  for (const o of options) {
    const list = byKind.get(o.kind) || []
    list.push(o)
    byKind.set(o.kind, list)
  }
  const kinds = [...byKind.keys()]
  const out: AiCoachOption[] = []
  let i = 0
  while (out.length < max && kinds.some((k) => (byKind.get(k) || []).length)) {
    const k = kinds[i % kinds.length]!
    const list = byKind.get(k) || []
    const next = list.shift()
    if (next) out.push(next)
    i += 1
    if (i > 40) break
  }
  return out
}

/** Prefer dropping notes / late packed / duplicate restaurants over early anchors. */
function pickWeakRemovals(
  dayItems: AiCoachDayItem[],
  count: number,
): AiCoachDayItem[] {
  const pool = dayItems.filter(isRemovableDayItem).filter((i) => i.type !== 'drive')
  if (!pool.length || count <= 0) return []
  const scored = pool.map((i, idx) => {
    let score = idx // later in list slightly preferred
    if (i.type === 'note') score += 40
    if (i.type === 'other') score += 15
    if (i.type === 'restaurant') score += 8
    if (i.type === 'sight' || i.type === 'activity') score += 12
    if (i.start && i.start >= '16:00') score += 10
    if (i.start && i.start < '11:00') score -= 8
    return { i, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const keepFloor = Math.max(1, pool.length - count) // never empty the day of all content
  const maxDrop = Math.min(count, pool.length - Math.min(1, keepFloor))
  return scored.slice(0, Math.max(1, maxDrop)).map((s) => s.i)
}

/** Local variant bank — always aims for a diversified shelf. */
export function localHeuristicOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
): AiCoachOption[] {
  const intent = detectCoachIntent(body.userMessage)
  const fill =
    body.dayFillLevel ?? (body.thinDay ? 'empty' : 'partial')
  const day = body.day
  const foodAll = preferOpenAt(
    candidates
      .filter((c) => c.category === 'food' || c.category === 'drink')
      .sort(rankFood),
    day,
    '13:00',
  )
  const cafes = preferOpenAt(foodAll.filter(isCafePlace), day, '09:00')
  const pubs = preferOpenAt(foodAll.filter(isPubPlace), day, '21:00')
  const dinners = preferOpenAt(
    foodAll.filter(isDinnerPlace).sort(rankFood),
    day,
    '19:30',
  )
  const lunches = preferOpenAt(
    foodAll
      .filter((p) => p.category === 'food' && !isCafePlace(p) && !isPubPlace(p))
      .sort(rankFood),
    day,
    '13:00',
  )
  const sights = preferOpenAt(
    candidates
      .filter((c) => c.category === 'sights' || c.category === 'nature')
      .sort(rankSight),
    day,
    '11:00',
  )
  const sightsFar = sights.filter((c) => c.distKm >= 8)
  const sightsNear = sights.filter((c) => c.distKm < 8)
  const views = preferOpenAt(
    candidates
      .filter((c) =>
        /view|lookout|panorama|belvedere|viewpoint|scenic/i.test(placeBlob(c)),
      )
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.distKm - a.distKm),
    day,
    '16:00',
  )

  const vehicle = body.dayItems.find((i) => i.isVehicleStop)
  const fromId = vehicle?.id
  const options: AiCoachOption[] = []

  function pickMeals(preferFar: boolean) {
    const used = new Set<string>()
    const pool = preferFar
      ? [...foodAll].sort((a, b) => b.distKm - a.distKm || rankFood(a, b))
      : foodAll
    const cafe =
      cafes.find((c) => !used.has(c.id)) ||
      pool.find((c) => isCafePlace(c)) ||
      pool.find((c) => c.category === 'food')
    if (cafe) used.add(cafe.id)
    const lunch =
      lunches.find((c) => !used.has(c.id)) ||
      pool.find((c) => c.category === 'food' && !isCafePlace(c) && !used.has(c.id))
    if (lunch) used.add(lunch.id)
    const dinner =
      dinners.find((c) => !used.has(c.id) && (c.rating ?? 0) >= 4) ||
      pubs.find((c) => !used.has(c.id)) ||
      dinners.find((c) => !used.has(c.id))
    if (dinner) used.add(dinner.id)
    const nightcap = intent.latePub
      ? pubs.find((c) => !used.has(c.id))
      : undefined
    return { cafe, lunch, dinner, nightcap }
  }

  // —— Empty shelves ——
  if (fill === 'empty') {
    if (intent.drive) {
      const dest =
        sightsFar[0] || views[0] || sightsNear[0] || lunches[0] || foodAll[0]
      if (dest) {
        const used = new Set([dest.id])
        const pit =
          views.find((v) => !used.has(v.id)) ||
          sightsFar.find((s) => !used.has(s.id))
        const meals = pickMeals(true)
        const addSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        if (meals.cafe) {
          addSteps.push({
            candidateId: meals.cafe.id,
            start: '09:00',
            note: 'Morning café',
          })
        }
        if (pit) {
          addSteps.push({
            candidateId: pit.id,
            start: '10:45',
            note: 'Viewpoint on the way',
          })
        }
        if (dest.category === 'sights' || dest.category === 'nature') {
          addSteps.push({
            candidateId: dest.id,
            start: '11:45',
            note: 'Main day-trip stop',
          })
        }
        if (meals.lunch) {
          addSteps.push({
            candidateId: meals.lunch.id,
            start: '13:00',
            note: 'Lunch',
          })
        }
        if (meals.dinner) {
          addSteps.push({
            candidateId: meals.dinner.id,
            start: '19:30',
            note: isPubPlace(meals.dinner) ? 'Evening pub' : 'Dinner',
          })
        }
        options.push({
          id: 'local-drive-day',
          label: 'Drive day plan',
          kind: 'itinerary',
          summary: `Drive toward ${dest.name} with meals timed to the route.`,
          rationale: 'Empty drive day: vehicle → scenic stop → destination → meals.',
          patch: {
            addDrives: [
              {
                fromItemId: fromId,
                toCandidateId: pit?.id || dest.id,
                start: '10:00',
                end: '10:40',
              },
            ],
            addSteps,
          },
        })
      }
      // Stay-local alternative
      if (sightsNear[0] || foodAll[0]) {
        const meals = pickMeals(false)
        const fun = sightsNear[0] || sights[0]
        const steps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        if (meals.cafe) {
          steps.push({
            candidateId: meals.cafe.id,
            start: '09:30',
            note: 'Café near base',
          })
        }
        if (fun) {
          steps.push({
            candidateId: fun.id,
            start: '11:00',
            note: 'Stay-local highlight',
          })
        }
        if (meals.lunch) {
          steps.push({
            candidateId: meals.lunch.id,
            start: '13:00',
            note: 'Lunch',
          })
        }
        if (steps.length) {
          options.push({
            id: 'local-stay-near',
            label: 'Stay near base',
            kind: 'highlight',
            summary: fun
              ? `Local day around ${fun.name}`
              : 'Keep the day closer to your start.',
            rationale: 'Alternative to driving far — useful if energy is low.',
            patch: { addSteps: steps },
          })
        }
      }
      if (views[0]) {
        options.push({
          id: 'local-view-pits',
          label: 'Viewpoint pit stops',
          kind: 'viewpoint',
          summary: `Scenic detours: ${views
            .slice(0, 2)
            .map((v) => v.name)
            .join(' & ')}`,
          rationale: 'Drive-day alternative focused on views.',
          patch: {
            addSteps: views.slice(0, 2).map((p, i) => ({
              candidateId: p.id,
              start: i === 0 ? '10:30' : '16:00',
            })),
          },
        })
      }
    }

    if (intent.fill || intent.fun || intent.generic || intent.food || !body.userMessage.trim()) {
      const meals = pickMeals(false)
      const fun = sightsNear[0] || sights[0] || views[0] || sightsFar[0]
      const fun2 = sights.find((s) => s.id !== fun?.id) || views.find((v) => v.id !== fun?.id)
      const fillSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
      if (meals.cafe) {
        fillSteps.push({
          candidateId: meals.cafe.id,
          start: '09:00',
          note: 'Morning café',
        })
      }
      if (fun && (intent.fill || intent.fun || intent.generic || !intent.food)) {
        fillSteps.push({
          candidateId: fun.id,
          start: '10:30',
          note: 'Fun thing in the area',
        })
      }
      if (meals.lunch) {
        fillSteps.push({
          candidateId: meals.lunch.id,
          start: '13:00',
          note: 'Lunch',
        })
      }
      if (fun2 && (intent.fill || intent.fun || intent.generic)) {
        fillSteps.push({
          candidateId: fun2.id,
          start: '15:30',
          note: 'Afternoon activity',
        })
      }
      if (meals.dinner) {
        fillSteps.push({
          candidateId: meals.dinner.id,
          start: '19:30',
          note: isPubPlace(meals.dinner) ? 'High-rated pub' : 'Dinner',
        })
      }
      if (meals.nightcap) {
        fillSteps.push({
          candidateId: meals.nightcap.id,
          start: '21:15',
          note: 'Pub after dinner',
        })
      }
      if (fillSteps.length >= 2) {
        options.push({
          id: 'local-fill-day',
          label: 'Fill the day',
          kind: 'itinerary',
          summary: fun
            ? `Café, ${fun.name}, lunch & dinner`
            : 'Café, lunch and dinner arc',
          rationale:
            'Empty-day fill with café + activity + meals — not café alone.',
          patch: { addSteps: fillSteps },
        })
      }

      if (sights[0] && sights[1]) {
        options.push({
          id: 'local-must-see',
          label: 'Must-see pack',
          kind: 'highlight',
          summary: `${sights[0].name} & ${sights[1].name}`,
          rationale: 'Two top sights/nature stops if you want activity-first.',
          patch: {
            addSteps: [
              {
                candidateId: sights[0].id,
                start: '10:30',
                note: 'Must-see',
              },
              {
                candidateId: sights[1].id,
                start: '15:00',
                note: 'Second highlight',
              },
            ],
          },
        })
      } else if (sights[0]) {
        options.push({
          id: 'local-must-see',
          label: `See ${sights[0].name}`.slice(0, 40),
          kind: 'highlight',
          summary: `Activity: ${sights[0].name}`,
          rationale: 'Single strong sight/nature stop.',
          patch: {
            addSteps: [
              {
                candidateId: sights[0].id,
                start: '11:00',
                note: 'Must-see',
              },
            ],
          },
        })
      }

      if (intent.food || intent.generic || intent.fill) {
        const meals = pickMeals(false)
        const mealSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        if (meals.cafe) {
          mealSteps.push({
            candidateId: meals.cafe.id,
            start: '09:00',
            note: 'Morning café',
          })
        }
        if (meals.lunch) {
          mealSteps.push({
            candidateId: meals.lunch.id,
            start: '13:00',
            note: 'Lunch',
          })
        }
        if (meals.dinner) {
          mealSteps.push({
            candidateId: meals.dinner.id,
            start: '19:30',
            note: isPubPlace(meals.dinner) ? 'Pub' : 'Dinner',
          })
        }
        if (mealSteps.length >= 2) {
          options.push({
            id: 'local-meals-3',
            label: 'Café, lunch & dinner',
            kind: 'food',
            summary: mealSteps
              .map(
                (s) =>
                  candidates.find((c) => c.id === s.candidateId)?.name || s.note,
              )
              .join(' · '),
            rationale: 'Food-only arc for an empty day (3 meal stops).',
            patch: { addSteps: mealSteps },
          })
        }
      }
    }
  }

  // —— Partial shelves ——
  if (fill === 'partial') {
    if (intent.fun || intent.fill || intent.generic) {
      const picks = (sightsNear.length ? sightsNear : sights).slice(0, 2)
      picks.forEach((pick, idx) => {
        options.push({
          id: `local-activity-${idx}`,
          label: `Add ${pick.name}`.slice(0, 40),
          kind: 'highlight',
          summary: `Fun in the area: ${pick.name}`,
          rationale: 'Partly filled day — sights/nature only for activity asks.',
          patch: {
            addSteps: [
              {
                candidateId: pick.id,
                start: idx === 0 ? '11:00' : '15:30',
                note: 'Fun thing in the area',
              },
            ],
          },
        })
      })
    }

    if (intent.food || intent.generic || intent.fill) {
      const gaps = body.dayItems
      const hasMorning = gaps.some(
        (i) => i.type === 'restaurant' && i.start && i.start < '11:00',
      )
      const hasLunch = gaps.some(
        (i) =>
          i.type === 'restaurant' &&
          i.start &&
          i.start >= '11:30' &&
          i.start < '16:00',
      )
      const hasDinner = gaps.some(
        (i) => i.type === 'restaurant' && i.start && i.start >= '18:00',
      )
      const gapSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
      if (!hasMorning && cafes[0]) {
        gapSteps.push({
          candidateId: cafes[0].id,
          start: '09:00',
          note: 'Morning café gap',
        })
      }
      if (!hasLunch && (lunches[0] || foodAll[0])) {
        gapSteps.push({
          candidateId: (lunches[0] || foodAll[0]!).id,
          start: '13:00',
          note: 'Lunch gap',
        })
      }
      if (!hasDinner && (dinners[0] || pubs[0])) {
        const d = dinners[0] || pubs[0]!
        gapSteps.push({
          candidateId: d.id,
          start: '19:30',
          note: isPubPlace(d) ? 'Evening pub' : 'Dinner gap',
        })
      }
      if (intent.latePub && pubs[0]) {
        const p =
          pubs.find((x) => !gapSteps.some((s) => s.candidateId === x.id)) ||
          pubs[0]
        gapSteps.push({
          candidateId: p.id,
          start: '21:15',
          note: 'Pub after dinner',
        })
      }
      if (gapSteps.length) {
        options.push({
          id: 'local-gap-meals',
          label: 'Fill meal gaps',
          kind: 'food',
          summary: `Add ${gapSteps.length} missing meal stop${gapSteps.length > 1 ? 's' : ''}.`,
          rationale: 'Only plugs café/lunch/dinner gaps on a partial day.',
          patch: { addSteps: gapSteps.slice(0, 3) },
        })
      }
    }

    if (intent.views && views[0]) {
      options.push({
        id: 'local-views-partial',
        label: 'Add a viewpoint',
        kind: 'viewpoint',
        summary: views[0].name,
        rationale: 'Scenic add without rebuilding the day.',
        patch: {
          addSteps: [{ candidateId: views[0].id, start: '16:00' }],
        },
      })
    }

    const removable = body.dayItems.filter(isRemovableDayItem)
    if ((intent.trim || removable.length >= 4) && removable.length >= 2) {
      const dropCount = intent.trim ? Math.min(3, removable.length - 1) : 2
      const drop = pickWeakRemovals(body.dayItems, dropCount)
      if (drop.length) {
        options.push({
          id: 'local-trim-partial',
          label: 'Lighten the day',
          kind: 'trim',
          summary: `Drop ${drop.map((d) => d.title).join(' & ')}.`,
          rationale: 'Removes weaker stops (and orphan drives on apply).',
          patch: { removeSteps: drop.map((d) => ({ itemId: d.id })) },
        })
      }
    }

    if (intent.pace || intent.generic) {
      const timed = body.dayItems.filter(
        (i) => !i.isPlaceholder && i.start && TIME_HM.test(i.start),
      )
      if (timed.length >= 2) {
        options.push({
          id: 'local-pace-partial',
          label: 'Loosen the pacing',
          kind: 'pacing',
          summary: 'Spread existing stops with clearer gaps.',
          rationale: 'Retimes this day only so meals and sights breathe.',
          patch: {
            setTimes: timed.slice(0, 4).map((i, idx) => ({
              itemId: i.id,
              start: `${String(9 + idx * 2).padStart(2, '0')}:30`,
            })),
          },
        })
      }
    }
  }

  // —— Full shelves ——
  if (fill === 'full') {
    const removable = body.dayItems.filter(isRemovableDayItem)
    if (removable.length >= 2) {
      const dropCount =
        intent.trim || removable.length >= 6
          ? Math.min(4, removable.length - 1)
          : Math.min(3, removable.length - 1)
      const drop = pickWeakRemovals(body.dayItems, dropCount)
      if (drop.length) {
        options.push({
          id: 'local-trim-full',
          label: 'Lighten the day',
          kind: 'trim',
          summary: `Drop ${drop.map((d) => d.title).join(' & ')}.`,
          rationale: 'Busy day — cut weaker stops so the rest can breathe.',
          patch: { removeSteps: drop.map((d) => ({ itemId: d.id })) },
        })
      }
    }
    const upgrade =
      dinners.find((d) => (d.rating ?? 0) >= 4.2) ||
      views[0] ||
      sightsNear[0] ||
      sights[0]
    if (upgrade) {
      options.push({
        id: 'local-upgrade',
        label:
          upgrade.category === 'food' || upgrade.category === 'drink'
            ? 'Upgrade dinner'
            : 'Add a highlight',
        kind:
          upgrade.category === 'food' || upgrade.category === 'drink'
            ? 'food'
            : 'highlight',
        summary: upgrade.name,
        rationale: 'One quality upgrade without rebuilding the day.',
        patch: {
          addSteps: [
            {
              candidateId: upgrade.id,
              start:
                upgrade.category === 'food' || upgrade.category === 'drink'
                  ? '19:30'
                  : '16:00',
              note: 'Quality upgrade',
            },
          ],
        },
      })
    }
    const timed = body.dayItems.filter(
      (i) => !i.isPlaceholder && i.start && TIME_HM.test(i.start),
    )
    if (timed.length >= 2) {
      options.push({
        id: 'local-pace-full',
        label: 'Loosen the pacing',
        kind: 'pacing',
        summary: 'Spread stops so the day breathes.',
        rationale: 'Full-day polish via retimes only.',
        patch: {
          setTimes: timed.slice(0, 5).map((i, idx) => ({
            itemId: i.id,
            start: `${String(9 + idx * 2).padStart(2, '0')}:00`,
          })),
        },
      })
    }
  }

  // Activity-only on any fill if still missing
  if (
    intent.fun &&
    !options.some((o) => o.kind === 'highlight' || o.id.startsWith('local-activity'))
  ) {
    const pick = sights[0]
    if (pick) {
      options.push({
        id: 'local-activity',
        label: `Add ${pick.name}`.slice(0, 40),
        kind: 'highlight',
        summary: `Activity/sight: ${pick.name}`,
        rationale: 'Fun ask → sights/nature, never a restaurant substitute.',
        patch: {
          addSteps: [
            {
              candidateId: pick.id,
              start: fill === 'empty' ? '11:00' : '15:00',
              note: 'Suggested activity',
            },
          ],
        },
      })
    }
  }

  // Last resort: two distinct adds, never a lone mystery café as the only card
  if (!options.length && candidates.length) {
    const preferSight = intent.fun ? sights[0] : null
    const a = preferSight || candidates[0]!
    const b =
      candidates.find(
        (c) =>
          c.id !== a.id &&
          (intent.fun
            ? c.category === 'sights' || c.category === 'nature'
            : true),
      ) || candidates.find((c) => c.id !== a.id)
    options.push({
      id: 'local-a',
      label: `Add ${a.name}`.slice(0, 40),
      kind:
        explorePlaceToItemType(a) === 'restaurant' ? 'food' : 'highlight',
      summary: a.summary || `${a.distKm.toFixed(1)} km away`,
      rationale: 'Grounded add matching the ask.',
      patch: { addSteps: [{ candidateId: a.id, start: '11:00' }] },
    })
    if (b) {
      options.push({
        id: 'local-b',
        label: `Add ${b.name}`.slice(0, 40),
        kind:
          explorePlaceToItemType(b) === 'restaurant' ? 'food' : 'highlight',
        summary: b.summary || `${b.distKm.toFixed(1)} km away`,
        rationale: 'Second alternative stop.',
        patch: { addSteps: [{ candidateId: b.id, start: '15:00' }] },
      })
    }
  }

  return diversifyByKind(dedupeOptions(options), 5)
}

function repairJunkOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): AiCoachOption[] {
  const intent = detectCoachIntent(body.userMessage)
  if (!intent.fun && !intent.fill) return options
  const byId = new Map(candidates.map((c) => [c.id, c]))
  return options.filter((o) => {
    const steps = o.patch.addSteps ?? []
    if (steps.length !== 1) return true
    const c = byId.get(steps[0]!.candidateId)
    if (!c) return true
    if (c.category === 'food' || c.category === 'drink') return false
    return true
  })
}

/**
 * Deterministic repair + critique for one propose pass.
 * Auto-fixes cheap issues (drive without stop); collects the rest for a revise call.
 */
export function critiqueAndRepairOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): { options: AiCoachOption[]; issues: string[] } {
  const intent = detectCoachIntent(body.userMessage)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const fill =
    body.dayFillLevel ?? (body.thinDay ? 'empty' : 'partial')
  const issues: string[] = []
  const out: AiCoachOption[] = []

  for (const raw of options) {
    const opt: AiCoachOption = {
      ...raw,
      patch: {
        ...raw.patch,
        addSteps: [...(raw.patch.addSteps ?? [])],
        addDrives: [...(raw.patch.addDrives ?? [])],
        setTimes: [...(raw.patch.setTimes ?? [])],
        removeSteps: [...(raw.patch.removeSteps ?? [])],
      },
    }
    const steps = opt.patch.addSteps ?? []
    const drives = opt.patch.addDrives ?? []
    const stepIds = new Set(steps.map((s) => s.candidateId))

    // Auto-repair: every drive destination must also be a stop (no revise needed)
    for (const d of drives) {
      if (stepIds.has(d.toCandidateId)) continue
      if (!byId.has(d.toCandidateId)) {
        issues.push(
          `Option "${opt.label}": drive to unknown candidate ${d.toCandidateId} — remove or replace.`,
        )
        continue
      }
      const arrive = d.end || d.start || '12:00'
      steps.push({
        candidateId: d.toCandidateId,
        start: arrive,
        note: 'Stop at end of drive',
      })
      stepIds.add(d.toCandidateId)
    }
    opt.patch.addSteps = steps

    // Closed at visit time — strip locally; ask model to replace if option goes empty later
    for (const s of [...(opt.patch.addSteps ?? [])]) {
      const place = byId.get(s.candidateId)
      if (!place) continue
      const start = s.start || '12:00'
      if (!placeOpenFor(place, body.day, start)) {
        issues.push(
          `Option "${opt.label}": ${place.name} is closed around ${start} on ${body.day} — pick an open place or different time.`,
        )
        opt.patch.addSteps = (opt.patch.addSteps ?? []).filter(
          (x) => !(x.candidateId === s.candidateId && x.start === s.start),
        )
      }
    }

    // Fun/activity ≠ restaurant substitute
    if (intent.fun) {
      const adds = opt.patch.addSteps ?? []
      const hasSight = adds.some((s) => {
        const p = byId.get(s.candidateId)
        return p && (p.category === 'sights' || p.category === 'nature')
      })
      const onlyFood =
        adds.length > 0 &&
        adds.every((s) => {
          const p = byId.get(s.candidateId)
          return p && (p.category === 'food' || p.category === 'drink')
        })
      if (onlyFood || (!hasSight && opt.kind !== 'food' && opt.kind !== 'trim' && opt.kind !== 'pacing')) {
        if (onlyFood) {
          issues.push(
            `Option "${opt.label}": fun/activity ask must include a sights/nature stop — not only restaurants.`,
          )
        }
      }
    }

    // Empty fill: lone café is junk
    if (
      (fill === 'empty' && (intent.fill || intent.fun || intent.generic)) ||
      intent.fill
    ) {
      const adds = opt.patch.addSteps ?? []
      if (adds.length === 1) {
        const p = byId.get(adds[0]!.candidateId)
        if (p && (p.category === 'food' || p.category === 'drink')) {
          issues.push(
            `Option "${opt.label}": empty/fill day must not be only a café — include sight + meals or a fuller itinerary.`,
          )
        }
      }
    }

    // Trim must actually remove something meaningful
    if (opt.kind === 'trim') {
      const rms = opt.patch.removeSteps ?? []
      if (!rms.length) {
        issues.push(
          `Option "${opt.label}": trim has no removeSteps — use real dayItems.id values.`,
        )
      }
    }

    // Chronology: flag severe out-of-order starts
    const timed = (opt.patch.addSteps ?? [])
      .filter((s) => s.start)
      .map((s) => s.start!)
    for (let i = 1; i < timed.length; i++) {
      if (timed[i]! < timed[i - 1]!) {
        issues.push(
          `Option "${opt.label}": stop times go backwards (${timed[i - 1]} then ${timed[i]}) — order chronologically.`,
        )
        break
      }
    }

    const hasAction =
      (opt.patch.addSteps?.length ?? 0) ||
      (opt.patch.addDrives?.length ?? 0) ||
      (opt.patch.setTimes?.length ?? 0) ||
      (opt.patch.removeSteps?.length ?? 0) ||
      opt.patch.addNote
    if (hasAction) out.push(opt)
    else {
      issues.push(`Option "${opt.label}": patch became empty after repairs — rebuild it.`)
    }
  }

  // Deduplicate issues for the revise prompt
  const uniqIssues = [...new Set(issues)].slice(0, 12)
  return { options: out, issues: uniqIssues }
}

/** Keep model options as-is; only fall back locally when nothing usable remains. */
export function finalizeCoachOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): AiCoachOption[] {
  const cleaned = repairJunkOptions(body, candidates, options)
  const repaired = critiqueAndRepairOptions(body, candidates, cleaned)
  if (repaired.options.length) {
    return diversifyByKind(dedupeOptions(repaired.options), 5).slice(0, 5)
  }
  const local = localHeuristicOptions(body, candidates).slice(0, 2)
  return diversifyByKind(dedupeOptions(local), 5).slice(0, 2)
}

/** @deprecated use finalizeCoachOptions — kept so older imports keep working */
export function ensureMinCoachOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): AiCoachOption[] {
  return finalizeCoachOptions(body, candidates, options)
}

async function fetchCoachOnce(
  body: AiCoachRequestBody,
  signal?: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/ai-coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = (await res.json()) as unknown
  if (res.ok) return { ok: true, data }
  const err =
    data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : `Coach failed (${res.status})`
  return { ok: false, status: res.status, error: err }
}

export async function requestCoachAdvice(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  signal?: AbortSignal,
): Promise<AiCoachApiResponse> {
  try {
    // Pass 1 — propose
    let pass = await fetchCoachOnce(body, signal)
    if (!pass.ok) {
      if (pass.status === 503 || /GEMINI|API key|not configured/i.test(pass.error)) {
        const options = finalizeCoachOptions(
          body,
          candidates,
          localHeuristicOptions(body, candidates),
        )
        if (options.length) return { kind: 'options', options }
      }
      throw new Error(pass.error)
    }

    let parsed = parseCoachResponse(
      pass.data,
      candidates,
      body.dayItems,
      body.day,
    )

    if (parsed.kind === 'need_clarification') {
      if (
        body.clarifications.some((c) => /Coach asked:/i.test(c)) &&
        body.clarifications.some((c) => /User replied:/i.test(c))
      ) {
        const local = finalizeCoachOptions(body, candidates, [])
        if (local.length) return { kind: 'options', options: local }
      }
      return parsed
    }

    // Deterministic critique; at most one revise call when issues remain
    let working = parsed.options
    const first = critiqueAndRepairOptions(body, candidates, working)
    working = first.options

    const needsRevise =
      first.issues.length > 0 &&
      (working.length === 0 ||
        first.issues.some((i) =>
          /closed|fun\/activity|only a café|no removeSteps|backwards|rebuild|unknown candidate/i.test(
            i,
          ),
        ))

    if (needsRevise && !body.critiqueFeedback?.length) {
      const reviseBody: AiCoachRequestBody = {
        ...body,
        critiqueFeedback: first.issues,
      }
      const second = await fetchCoachOnce(reviseBody, signal)
      if (second.ok) {
        const revised = parseCoachResponse(
          second.data,
          candidates,
          body.dayItems,
          body.day,
        )
        if (revised.kind === 'options' && revised.options.length) {
          const again = critiqueAndRepairOptions(
            body,
            candidates,
            revised.options,
          )
          working = again.options.length ? again.options : working
        }
      }
    }

    return {
      kind: 'options',
      options: finalizeCoachOptions(body, candidates, working),
    }
  } catch (e) {
    if (signal?.aborted) throw e
    const options = finalizeCoachOptions(
      body,
      candidates,
      localHeuristicOptions(body, candidates),
    )
    if (options.length) return { kind: 'options', options }
    throw e instanceof Error ? e : new Error('Coach request failed')
  }
}

export function formatDayChipLabel(meta: TripMeta, day: string): string {
  const start = meta.startDate
  if (!start) return day.slice(5)
  const a = new Date(start + 'T12:00:00')
  const b = new Date(day + 'T12:00:00')
  const n = Math.round((b.getTime() - a.getTime()) / 86400000) + 1
  const short = day.slice(5).replace('-', '/')
  return `Day ${n} · ${short}`
}
