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
import { chainDrivesForSteps } from './aiCoachPatch'

const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)$/

export type CoachIntent = {
  fill: boolean
  fun: boolean
  drive: boolean
  food: boolean
  wine: boolean
  water: boolean
  city: boolean
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
  const water =
    /\b(beach|beaches|lake|lakes|sea|ocean|river|rivers|canal|lagoon|cove|bay|fjord|waterfront|waterside|lakeside|seaside|coast|coastal|marina|harbour|harbor|swim|swimming|boat|boating|kayak|canoe|paddle|plage|lac|mer|calanque|promenade)\b|near\s+(the\s+)?water|by\s+(the\s+)?water|water\s*(day|activit|side)|bord\s+de\s+l['’ ]?eau|au\s+bord\s+de/i.test(
      m,
    )
  const fill =
    /fill|plan\s*(the\s*)?day|day\s*plan|itinerary|full\s*day|whole\s*day|empty\s*day|what\s*to\s*do|populate/i.test(
      m,
    ) ||
    (water && /\bday\b|plan|itinerary|fill|explore/.test(m))
  const fun =
    /fun|activit|sight|museum|hike|walk|explore|thing to do|things to do|something to do|must.?see|highlight|attraction|sightseeing/i.test(
      m,
    ) || water
  const drive =
    /drive|car|road\s*trip|scenic|provence|countryside|day\s*trip|take the car|luberon|tuscany|amalfi/i.test(
      m,
    )
  const wine =
    /\bwine\b|winery|wineries|vineyard|cave\s*(à|a)\s*vin|dégust|degustat|enoteca|weinprobe/i.test(
      m,
    )
  const food =
    /eat|food|lunch|dinner|breakfast|restaurant|nice\s*meal|cuisine|caf[eé]|coffee|romantic|pub|bar/i.test(
      m,
    ) || wine // wine day still wants meal slots nearby, but wine is not “food mode” alone
  const city =
    /city|urban|downtown|old\s*town|centro|centre|museum|gallery|boulevard|plaza|square|quartier|neighborhood|neighbourhood/i.test(
      m,
    ) ||
    (/explore|sight|sightseeing|things to do|activit|fun|fill|plan/.test(m) &&
      !water &&
      !/provence|countryside|village|vineyard|luberon|tuscany|chianti|amalfi/i.test(m))
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
    !wine &&
    !water &&
    !city &&
    !views &&
    !trim &&
    !pace &&
    (/help|improve|suggest|idea|option|recommend|anything|something|^$/i.test(m) ||
      m.trim().length < 12)
  return {
    fill,
    fun,
    drive,
    food,
    wine,
    water,
    city,
    views,
    trim,
    pace,
    latePub,
    generic,
  }
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
  const avail = resolveDayAvailability(items, day)
  const content = dayItems.filter(
    (i) =>
      ['sight', 'restaurant', 'activity', 'city', 'other'].includes(i.type) &&
      !isVehicleStop(i),
  )
  const restaurants = content.filter((i) => i.type === 'restaurant')
  const sights = content.filter(
    (i) => i.type === 'sight' || i.type === 'activity',
  )
  const gate = avail.earliestStart
  const hasMorning = restaurants.some(
    (i) => i.start && i.start < '11:00' && (!gate || i.start >= gate),
  )
  const hasLunch = restaurants.some(
    (i) =>
      i.start &&
      i.start >= '11:30' &&
      i.start < '16:00' &&
      (!gate || i.start >= gate),
  )
  const hasDinner = restaurants.some(
    (i) => i.start && i.start >= '18:00' && (!gate || i.start >= gate),
  )
  // Don't ask to fill meal slots that are impossible before arrival / in transit
  const morningPossible =
    !avail.inTransitAllDay && (!gate || gate < '11:00')
  const lunchPossible =
    !avail.inTransitAllDay && (!gate || gate < '15:00')
  const dinnerPossible =
    !avail.inTransitAllDay && (!gate || gate < '21:00')
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
      morning: morningPossible && !hasMorning,
      lunch: lunchPossible && !hasLunch,
      dinner: dinnerPossible && !hasDinner,
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

function minToHm(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function addMinutesHm(hm: string, minutes: number): string {
  return minToHm(timeToMin(hm) + minutes)
}

const TRANSIT_TYPES = new Set(['flight', 'train', 'bus', 'ferry'])

export type DayAvailability = {
  /** Earliest HH:MM for new stops (after transit arrival + buffer). */
  earliestStart: string | null
  /** True when a multi-day transit covers this whole calendar day. */
  inTransitAllDay: boolean
  /** Short labels for planningHints / UI. */
  notes: string[]
}

/**
 * Respect flights/trains/buses/ferries: never schedule coach stops before you
 * arrive, and treat mid-journey days as fully in transit.
 */
export function resolveDayAvailability(
  items: TripItem[],
  day: string,
): DayAvailability {
  const notes: string[] = []
  let earliestMin: number | null = null
  let inTransitAllDay = false

  for (const item of items) {
    if (item.status === 'cancelled') continue
    if (!TRANSIT_TYPES.has(item.type)) continue

    const departDay = item.date
    const arriveDay =
      item.endDate && /^\d{4}-\d{2}-\d{2}$/.test(item.endDate)
        ? item.endDate
        : item.date
    const departHm = TIME_HM.test(item.start) ? item.start : ''
    const arriveHm = TIME_HM.test(item.end)
      ? item.end
      : TIME_HM.test(item.start)
        ? item.start
        : ''

    // Still aboard all day (left earlier, arrives later)
    if (departDay < day && arriveDay > day) {
      inTransitAllDay = true
      notes.push(
        `${item.type} “${item.title || item.from || 'leg'}” is in progress all day — do not add sightseeing/meals on this day.`,
      )
      continue
    }

    // Arrives today (same-day hop or multi-day arrival)
    if (arriveDay === day && arriveHm) {
      const buffer =
        item.type === 'flight' ? 60 : item.type === 'ferry' ? 45 : 30
      const free = timeToMin(arriveHm) + buffer
      if (earliestMin == null || free > earliestMin) {
        earliestMin = free
      }
      const label =
        item.type === 'flight'
          ? 'flight'
          : item.type === 'train'
            ? 'train'
            : item.type === 'ferry'
              ? 'ferry'
              : 'bus'
      notes.push(
        `${label} arrives ${arriveHm}${
          departDay < day ? ` (started ${departDay})` : ''
        } — first new stop no earlier than ${minToHm(free)} (includes ${buffer}m buffer).`,
      )
    }

    // Departs today on a multi-day leg (not arriving today): leave after departure
    if (departDay === day && arriveDay > day && departHm) {
      notes.push(
        `${item.type} “${item.title || ''}” departs ${departHm} and continues past today — only schedule before departure; nothing after you leave.`,
      )
    }
  }

  if (inTransitAllDay) {
    return { earliestStart: null, inTransitAllDay: true, notes }
  }

  const earliestStart =
    earliestMin != null ? minToHm(earliestMin) : null
  return { earliestStart, inTransitAllDay: false, notes }
}

/**
 * Build a sensible post-arrival arc. Slots before the gate are omitted
 * (e.g. afternoon flight → no morning café).
 */
export function slotsAfterArrival(earliestStart: string | null): {
  cafe?: string
  sight?: string
  lunch?: string
  afternoon?: string
  dinner?: string
} {
  if (!earliestStart) {
    return {
      cafe: '09:00',
      sight: '10:45',
      lunch: '13:00',
      afternoon: '16:00',
      dinner: '19:30',
    }
  }
  const e = timeToMin(earliestStart)
  const out: {
    cafe?: string
    sight?: string
    lunch?: string
    afternoon?: string
    dinner?: string
  } = {}

  if (e <= timeToMin('09:30')) {
    out.cafe = earliestStart > '09:00' ? earliestStart : '09:00'
    out.sight = addMinutesHm(out.cafe, 90)
    out.lunch = out.sight < '12:30' ? '13:00' : addMinutesHm(out.sight, 90)
    out.afternoon = '16:00'
    out.dinner = '19:30'
    return out
  }
  if (e <= timeToMin('11:30')) {
    out.sight = earliestStart
    out.lunch = earliestStart < '12:30' ? '13:00' : addMinutesHm(earliestStart, 75)
    out.afternoon = '16:30'
    out.dinner = '19:30'
    return out
  }
  if (e <= timeToMin('14:30')) {
    out.lunch = earliestStart
    out.afternoon = addMinutesHm(earliestStart, 120)
    out.dinner = '19:30'
    return out
  }
  if (e <= timeToMin('17:30')) {
    out.afternoon = earliestStart
    out.dinner = earliestStart < '18:30' ? '19:30' : addMinutesHm(earliestStart, 75)
    return out
  }
  if (e <= timeToMin('20:30')) {
    out.dinner = earliestStart
    return out
  }
  // Very late arrival — nothing sensible to add tonight
  return out
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

function isWinePlace(p: ExplorePlace): boolean {
  const b = placeBlob(p)
  return (
    /winery|vineyard|wine\s*tast|wine\s*cellar|cave|enoteca|domaine|ch[aâ]teau/.test(
      b,
    ) ||
    (p.category === 'drink' && /wine|vin/.test(b))
  )
}

function isWaterPlace(p: ExplorePlace): boolean {
  const b = placeBlob(p)
  const primary = (p.tags.primaryType || '').toLowerCase()
  return (
    primary === 'beach' ||
    primary === 'marina' ||
    /beach|plage|marina|harbour|harbor|waterfront|lakeside|seaside|promenade|pier|quay|quai|jetty|calanque|cove|bay|lake|lac\b|river|canal|lagoon|aquarium|boat\s*tour|ferry\s*terminal|swimming|kayak|canoe|paddle|surf|coast|seaside|bord\s+de\s+l/.test(
      b,
    ) ||
    (p.category === 'nature' &&
      /water|beach|lake|sea|river|coast|marina|harbour|harbor/.test(b))
  )
}

function isSeafoodPlace(p: ExplorePlace): boolean {
  const b = placeBlob(p)
  return /seafood|fish|oyster|shellfish|poisson|fruits?\s*de\s*mer|sushi|sashimi|ceviche|lobster|crab|moule|bouillabaisse|poissonnerie/.test(
    b,
  )
}

/** Coarse cuisine bucket so lunch/dinner aren’t both pizzerias. */
function cuisineFamily(p: ExplorePlace): string {
  const b = placeBlob(p)
  if (/pizza|pizzer/.test(b)) return 'pizza'
  if (isSeafoodPlace(p)) return 'seafood'
  if (/burger|steak|grill|bbq|barbecue|brasserie/.test(b)) return 'grill'
  if (/sushi|ramen|noodle|thai|chinese|japanese|vietnamese|korean|asian|pho|dim\s*sum/.test(b))
    return 'asian'
  if (/indian|curry|tandoor|biryani/.test(b)) return 'indian'
  if (/mexican|taco|burrito|tapas|spanish|paella/.test(b)) return 'iberian'
  if (/italian|trattoria|pasta|ristorante|osteria/.test(b)) return 'italian'
  if (/french|bistro|proven[cç]al|gastronom/.test(b)) return 'french'
  if (/cafe|café|bakery|coffee|patisserie|pâtisserie/.test(b)) return 'cafe'
  if (isPubPlace(p)) return 'pub'
  const cuisine = (p.tags.cuisine || '').toLowerCase().trim()
  if (cuisine) return cuisine.split(/[;,]/)[0]!.slice(0, 24)
  return 'other'
}

function isDinnerPlace(p: ExplorePlace): boolean {
  if (p.category !== 'food' && p.category !== 'drink') return false
  if (isCafePlace(p)) return false
  return true
}

function optionHasSight(
  o: AiCoachOption,
  byId: Map<string, ExplorePlace>,
): boolean {
  return (o.patch.addSteps ?? []).some((s) => {
    const c = byId.get(s.candidateId)
    return Boolean(
      c &&
        (c.category === 'sights' || c.category === 'nature') &&
        !isWinePlace(c),
    )
  })
}

function optionHasWine(
  o: AiCoachOption,
  byId: Map<string, ExplorePlace>,
): boolean {
  return (o.patch.addSteps ?? []).some((s) => {
    const c = byId.get(s.candidateId)
    return Boolean(c && isWinePlace(c))
  })
}

function optionHasWater(
  o: AiCoachOption,
  byId: Map<string, ExplorePlace>,
): boolean {
  return (o.patch.addSteps ?? []).some((s) => {
    const c = byId.get(s.candidateId)
    return Boolean(c && isWaterPlace(c))
  })
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

  // Night-before stay that still covers this morning (checkout today / later)
  const overnight = items.find(
    (i) =>
      i.type === 'hotel' &&
      !isPlaceholderBase(i) &&
      isValidCoord(i.lat, i.lon) &&
      i.date < day &&
      (!i.endDate || i.endDate >= day),
  )
  if (overnight) {
    return {
      lat: overnight.lat!,
      lon: overnight.lon!,
      label: overnight.title || overnight.place || 'Hotel',
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

function placeDedupeKey(p: {
  name: string
  lat: number
  lon: number
}): string {
  const name = p.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return `${name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`
}

function mergePlaces(into: Map<string, ExplorePlace>, list: ExplorePlace[]) {
  const byKey = new Map<string, string>()
  for (const [id, p] of into) {
    byKey.set(placeDedupeKey(p), id)
  }
  for (const p of list) {
    const key = placeDedupeKey(p)
    const existingId = byKey.get(key)
    if (!existingId) {
      into.set(p.id, p)
      byKey.set(key, p.id)
      continue
    }
    if (existingId === p.id) {
      into.set(p.id, p)
      continue
    }
    // Same venue from Google + OSM (or double Nearby) — keep the richer record
    const prev = into.get(existingId)!
    const score = (x: ExplorePlace) =>
      (x.tags.source === 'google' ? 4 : 0) +
      (x.rating != null ? 2 : 0) +
      (x.images.length ? 1 : 0) +
      (x.openingPeriods?.length ? 1 : 0)
    if (score(p) > score(prev)) {
      into.delete(existingId)
      into.set(p.id, p)
      byKey.set(key, p.id)
    }
  }
}

/** Collapse duplicate candidate ids / same venue within one option. */
function dedupeAddStepsByPlace(
  steps: NonNullable<AiCoachOption['patch']['addSteps']>,
  byId: Map<string, ExplorePlace>,
): NonNullable<AiCoachOption['patch']['addSteps']> {
  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  const out: NonNullable<AiCoachOption['patch']['addSteps']> = []
  for (const s of steps) {
    if (seenIds.has(s.candidateId)) continue
    const place = byId.get(s.candidateId)
    if (place) {
      const key = placeDedupeKey(place)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
    }
    seenIds.add(s.candidateId)
    out.push(s)
  }
  return out
}

function uniquePlaceCount(
  steps: NonNullable<AiCoachOption['patch']['addSteps']>,
  byId: Map<string, ExplorePlace>,
): number {
  const keys = new Set<string>()
  for (const s of steps) {
    const p = byId.get(s.candidateId)
    keys.add(p ? placeDedupeKey(p) : s.candidateId)
  }
  return keys.size
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

/**
 * Free-form area recommendations: Text Search near the day hotel/city, then
 * Nearby around those hits. Works for cities and countryside — not Provence-only.
 */
async function resolveAreaRecommendationAnchors(
  anchor: { lat: number; lon: number; label: string },
  intent: CoachIntent,
  fill: 'empty' | 'partial' | 'full',
  opts?: {
    signal?: AbortSignal
    useGooglePlaces?: boolean
    googleApiKey?: string
  },
): Promise<Array<{ lat: number; lon: number; label: string }>> {
  if (!opts?.useGooglePlaces) return []
  const area = (anchor.label || 'here').trim()
  const queries: string[] = []
  if (intent.fun || intent.fill || intent.city || fill === 'empty') {
    queries.push(`things to do near ${area}`)
    queries.push(`best sightseeing near ${area}`)
  }
  if (intent.city || intent.fun) {
    queries.push(`museum or historic site near ${area}`)
  }
  if (intent.water) {
    queries.push(`beach or waterfront near ${area}`)
    queries.push(`lake or marina near ${area}`)
    queries.push(`things to do by the water near ${area}`)
  }
  if (intent.wine) queries.push(`winery or wine tasting near ${area}`)
  if (intent.food || fill === 'empty') {
    queries.push(
      intent.water
        ? `seafood restaurant near ${area}`
        : `highly rated restaurant near ${area}`,
    )
  }
  if (intent.views || intent.drive) {
    queries.push(`viewpoint or scenic lookout near ${area}`)
  }
  if (!queries.length) queries.push(`popular attractions near ${area}`)

  const out: Array<{ lat: number; lon: number; label: string }> = []
  const seen = new Set<string>()
  try {
    const { fetchGoogleTextViaProxy } = await import('./placesGoogle')
    for (const q of queries.slice(0, intent.water ? 5 : 4)) {
      if (opts.signal?.aborted) break
      try {
        const hit = await fetchGoogleTextViaProxy({
          query: q,
          apiKey: opts.googleApiKey,
          bias: { lat: anchor.lat, lon: anchor.lon, radiusM: 40_000 },
          signal: opts.signal,
        })
        if (!hit || !isValidCoord(hit.lat, hit.lon)) continue
        const key = `${hit.lat.toFixed(3)},${hit.lon.toFixed(3)}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          lat: hit.lat,
          lon: hit.lon,
          label: hit.name || q,
        })
      } catch (err) {
        logClientError('ai-coach-area-text', err)
      }
    }
  } catch (err) {
    logClientError('ai-coach-area-import', err)
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

  const avail = resolveDayAvailability(items, day)
  for (const n of avail.notes) hints.push(n)
  if (avail.inTransitAllDay) {
    hints.push(
      'CRITICAL: traveler is in transit all day — do NOT add café/sights/meals. Prefer need_clarification or a note-only option if anything.',
    )
  } else if (avail.earliestStart) {
    hints.push(
      `CRITICAL: do not schedule any addSteps/addDrives before ${avail.earliestStart}. Skip morning/lunch slots that fall before arrival; start the day after the transit arrives.`,
    )
  }

  if (diagnosis.fillLevel === 'empty') {
    hints.push(
      'Empty/skeleton day: help fill THIS day. Prefer a full-day itinerary with café + fun sight + lunch + dinner when asked to fill/plan/fun.',
    )
    const bases = dayItemsForCoach(items, day).filter(isPlaceholderBase)
    if (bases.length) {
      hints.push(
        `Day-base placeholder(s) on this day (${bases.map((b) => `${b.title}→${b.id}`).join('; ')}): when adding real stops, include removeSteps for those ids OR the app will convert the base into your first new stop. Do not leave an empty “Day N base” hotel shell beside real plans.`,
      )
    }
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
  if (intent.fun || intent.fill || intent.city || diagnosis.fillLevel === 'empty') {
    hints.push(
      'Fill/fun/city/sights: EVERY option that adds stops must include ≥1 sights or nature candidate — never lunch+dinner alone. Prefer 2 sights on a full-day fill. Works for cities and countryside alike.',
    )
  }
  if (intent.wine) {
    hints.push(
      'Wine tasting: add ONE winery/wine-cellar stop when asked — as part of a normal day (with sights/meals if fill/fun), not a “wine-only” day mode. Never reuse the tasting venue as café/sight/dinner.',
    )
  }
  if (intent.water) {
    hints.push(
      'Water day: prioritize beach / lake / marina / waterfront / harbour / coastal promenade candidates (sights or nature). Include at least one water-oriented stop. Prefer seafood or waterfront dining when available — do not serve lunch and dinner as two pizzerias.',
    )
  }
  const avoided = avoidedPlaceNames(items, day)
  if (avoided.length) {
    hints.push(
      `Star-shaped / multi-day base: do NOT reuse places already planned on other days of this trip. Avoid: ${avoided.join('; ')}. Pick fresh candidates for THIS day.`,
    )
  }
  hints.push(
    'Travel: compact city days — hops under ~3 km are walks (no addDrives); open countryside / Provence-style days — use addDrives even for ~2 km village hops. Always addDrives for farther out-of-town stops.',
  )
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
    'Never schedule the same candidate/place twice on this day at different times — each stop must be a distinct candidate id.',
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
    if (intent.food || intent.latePub || intent.wine || fill === 'empty') {
      mergePlaces(
        byId,
        await safeExplore(anchor, intent.wine ? 8000 : 2200, intent.wine ? 24 : 16, [
          'food',
          'drink',
        ]),
      )
    }
    if (intent.wine) {
      mergePlaces(
        byId,
        await safeExplore(anchor, 12000, 20, ['drink']),
      )
    }
    if (intent.water) {
      mergePlaces(
        byId,
        await safeExplore(anchor, 18_000, 28, ['sights', 'nature']),
      )
      mergePlaces(
        byId,
        await safeExplore(anchor, 10_000, 16, ['food', 'drink']),
      )
    }
  }

  const regions = [
    ...(await resolveRegionAnchors(
      msg,
      anchor ? { lat: anchor.lat, lon: anchor.lon } : null,
      opts,
    )),
  ]
  if (anchor) {
    const areaAnchors = await resolveAreaRecommendationAnchors(
      anchor,
      intent,
      fill,
      opts,
    )
    for (const a of areaAnchors) {
      if (regions.some((r) => awaitableDist(r, a).distKm < 1.5)) continue
      regions.push(a)
    }
  }
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

  // Thin local pool → widen Nearby radius so the coach isn't forced to reuse the same pins
  if (anchor && !opts?.signal?.aborted) {
    const widenSteps: Array<{
      radiusM: number
      limit: number
      categories?: ExplorePlace['category'][]
    }> = [
      { radiusM: 5000, limit: 28 },
      { radiusM: 8000, limit: 36 },
      { radiusM: 12_000, limit: 40 },
      { radiusM: 18_000, limit: 48 },
      {
        radiusM: 25_000,
        limit: 56,
        categories: ['sights', 'nature', 'food', 'drink'],
      },
    ]
    for (const step of widenSteps) {
      if (opts?.signal?.aborted) break
      if (
        !coachPoolNeedsWiderSearch(
          [...byId.values()],
          intent,
          fill,
        )
      ) {
        break
      }
      mergePlaces(
        byId,
        await safeExplore(
          anchor,
          step.radiusM,
          step.limit,
          step.categories,
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

  const dayContent = dayItemsForCoach(items, day).filter(
    (i) =>
      i.status !== 'cancelled' &&
      !isPlaceholderBase(i) &&
      i.type !== 'drive' &&
      i.type !== 'note',
  )

  const fresh = list.filter((p) => {
    if (p.category === 'hotel') return false
    if (placeAlreadyOnDay(p, dayContent)) return false
    if (placeAlreadyOnTrip(p, items, day)) return false
    const hint = summarizeOpenSlots(day, p.openingPeriods, p.openingHours)
    return hint !== 'closed all typical slots'
  })
  // Soft fallback: if star-trip exclusion emptied the pool, allow other-day places last
  const reused =
    fresh.length >= 6
      ? []
      : list.filter((p) => {
          if (p.category === 'hotel') return false
          if (placeAlreadyOnDay(p, dayContent)) return false
          if (!placeAlreadyOnTrip(p, items, day)) return false
          const hint = summarizeOpenSlots(day, p.openingPeriods, p.openingHours)
          return hint !== 'closed all typical slots'
        })
  const ranked = [...fresh, ...reused]

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

function placeAlreadyOnDay(
  place: ExplorePlace,
  dayItems: TripItem[],
): boolean {
  const name = place.name.trim().toLowerCase()
  for (const i of dayItems) {
    if (
      isValidCoord(i.lat, i.lon) &&
      Math.abs(i.lat! - place.lat) < 1.2e-3 &&
      Math.abs(i.lon! - place.lon) < 1.2e-3
    ) {
      return true
    }
    const title = (i.title || '').trim().toLowerCase()
    if (name && title && (title === name || title.includes(name) || name.includes(title))) {
      // Avoid matching very short shared words
      if (name.length >= 4 && title.length >= 4) return true
    }
  }
  return false
}

/** Content stops on other calendar days — for star-shaped multi-night hotel bases. */
function tripContentOnOtherDays(
  items: TripItem[],
  exceptDay: string,
): TripItem[] {
  return items.filter(
    (i) =>
      i.status !== 'cancelled' &&
      !isPlaceholderBase(i) &&
      i.type !== 'drive' &&
      i.type !== 'note' &&
      i.type !== 'hotel' &&
      i.type !== 'flight' &&
      i.date !== exceptDay,
  )
}

function placeAlreadyOnTrip(
  place: ExplorePlace,
  items: TripItem[],
  exceptDay: string,
): boolean {
  return placeAlreadyOnDay(place, tripContentOnOtherDays(items, exceptDay))
}

function avoidedPlaceNames(items: TripItem[], exceptDay: string, max = 10): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const i of tripContentOnOtherDays(items, exceptDay)) {
    const n = (i.title || i.place || '').trim()
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(n)
    if (names.length >= max) break
  }
  return names
}

function coachPoolNeedsWiderSearch(
  places: ExplorePlace[],
  intent: CoachIntent,
  fill: 'empty' | 'partial' | 'full',
): boolean {
  const unique = new Set(
    places.filter((p) => p.category !== 'hotel').map(placeDedupeKey),
  )
  const sights = places.filter(
    (p) =>
      (p.category === 'sights' || p.category === 'nature') && !isWinePlace(p),
  ).length
  const food = places.filter(
    (p) => p.category === 'food' && !isWinePlace(p),
  ).length
  const drink = places.filter(
    (p) => p.category === 'drink' && !isWinePlace(p),
  ).length
  const wine = places.filter(isWinePlace).length
  const water = places.filter(isWaterPlace).length
  const total = unique.size

  if (intent.wine && (wine < 1 || sights < 2 || food < 2 || total < 6)) {
    return true
  }
  if (intent.water && (water < 1 || sights < 2 || food < 2 || total < 6)) {
    return true
  }
  if (intent.fill || intent.fun || fill === 'empty') {
    // Full-day plans need distinct sights + meals — not one winery three times
    return sights < 3 || food < 2 || total < 8
  }
  if (intent.food || intent.latePub) return food + drink < 5 || total < 6
  return total < 6
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
      placeholder ||
      (!vehicle &&
        ['sight', 'restaurant', 'activity', 'note', 'other', 'city', 'drive'].includes(
          i.type,
        ))
    return {
      id: i.id,
      type: i.type,
      title: i.title,
      place: i.place,
      date: i.date,
      endDate: i.endDate || undefined,
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

  const avail = resolveDayAvailability(trip.items, day)

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
    dayAvailability: {
      earliestStart: avail.earliestStart,
      inTransitAllDay: avail.inTransitAllDay,
      notes: avail.notes.slice(0, 6),
    },
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
  if (i.isVehicleStop) return false
  if (i.isPlaceholder || i.canRemove === true) return true
  if (i.canRemove === false) return false
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
      const fromCandidateId = String(r.fromCandidateId ?? '').trim()
      return {
        toCandidateId,
        fromItemId:
          fromItemId && dayItemIds.has(fromItemId) ? fromItemId : undefined,
        fromCandidateId:
          fromCandidateId && candidateIds.has(fromCandidateId)
            ? fromCandidateId
            : undefined,
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
  // Keep wineries out of meal/sight slots — they're reserved for tasting stops
  const mealPool = preferOpenAt(
    candidates
      .filter(
        (c) =>
          (c.category === 'food' || c.category === 'drink') && !isWinePlace(c),
      )
      .sort(rankFood),
    day,
    '13:00',
  )
  const foodAll = mealPool
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
      .filter(
        (c) =>
          (c.category === 'sights' || c.category === 'nature') &&
          !isWinePlace(c),
      )
      .sort((a, b) => {
        if (intent.water) {
          const aw = isWaterPlace(a) ? 1 : 0
          const bw = isWaterPlace(b) ? 1 : 0
          if (aw !== bw) return bw - aw
        }
        return rankSight(a, b)
      }),
    day,
    '11:00',
  )
  const sightsFar = sights.filter((c) => c.distKm >= 8)
  const sightsNear = sights.filter((c) => c.distKm < 8)
  const waters = preferOpenAt(
    candidates.filter(isWaterPlace).sort(rankSight),
    day,
    '11:00',
  )
  const views = preferOpenAt(
    candidates
      .filter((c) =>
        /view|lookout|panorama|belvedere|viewpoint|scenic/i.test(placeBlob(c)),
      )
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.distKm - a.distKm),
    day,
    '16:00',
  )
  const wines = preferOpenAt(
    candidates.filter(isWinePlace).sort(rankFood),
    day,
    '15:00',
  )

  const vehicle = body.dayItems.find((i) => i.isVehicleStop)
  const hotel = body.dayItems.find((i) => i.type === 'hotel')
  const fromId = vehicle?.id ?? hotel?.id
  const options: AiCoachOption[] = []
  const dayPlaceholders = body.dayItems.filter((i) => i.isPlaceholder)
  const avail = body.dayAvailability ?? {
    earliestStart: null,
    inTransitAllDay: false,
    notes: [],
  }
  const slots = avail.inTransitAllDay
    ? {}
    : slotsAfterArrival(avail.earliestStart)

  const clearBases = (): NonNullable<AiCoachOption['patch']['removeSteps']> =>
    dayPlaceholders.map((p) => ({ itemId: p.id }))

  function withClearedBases(patch: AiCoachOption['patch']): AiCoachOption['patch'] {
    if (!dayPlaceholders.length) return patch
    const existing = patch.removeSteps ?? []
    const seen = new Set(existing.map((r) => r.itemId))
    const extra = clearBases().filter((r) => !seen.has(r.itemId))
    if (!extra.length) return patch
    return { ...patch, removeSteps: [...existing, ...extra] }
  }

  // In-transit calendar day — don't invent a sightseeing day at either end
  if (avail.inTransitAllDay) {
    return [
      {
        id: 'local-in-transit',
        label: 'Still traveling',
        kind: 'other',
        summary: 'This day is spent in transit — nothing to add before you arrive.',
        rationale:
          'A flight/train/bus/ferry spans this whole day. Wait until the arrival day to fill activities.',
        patch: withClearedBases({
          addNote: {
            title: 'In transit',
            notes: avail.notes[0] || 'Travel day — no local plan until arrival.',
            start: '12:00',
          },
        }),
      },
    ]
  }

  function openAreaTravel(): boolean {
    return (
      intent.drive ||
      Boolean(vehicle) ||
      /provence|luberon|tuscany|countryside|vineyard|winery|village/i.test(
        body.userMessage,
      ) ||
      candidates.some((c) => c.distKm >= 8)
    )
  }

  /** Stop→stop drives (not a star from the hotel). */
  function drivesForFarSteps(
    steps: NonNullable<AiCoachOption['patch']['addSteps']>,
  ): NonNullable<AiCoachOption['patch']['addDrives']> {
    return chainDrivesForSteps(steps, candidates, {
      dayItems: [],
      fromItemId: fromId,
      openArea: openAreaTravel(),
    })
  }

  function patchWithDrives(
    steps: NonNullable<AiCoachOption['patch']['addSteps']>,
  ): AiCoachOption['patch'] {
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const uniqueSteps = dedupeAddStepsByPlace(steps, byId)
    const addDrives = drivesForFarSteps(uniqueSteps)
    return withClearedBases({
      addSteps: uniqueSteps,
      ...(addDrives.length ? { addDrives } : {}),
    })
  }

  function pushUnique(
    steps: NonNullable<AiCoachOption['patch']['addSteps']>,
    used: Set<string>,
    place: ExplorePlace | undefined,
    start: string | undefined,
    note: string,
  ) {
    if (!place || !start) return
    const key = placeDedupeKey(place)
    if (used.has(place.id) || used.has(key)) return
    used.add(place.id)
    used.add(key)
    steps.push({ candidateId: place.id, start, note })
  }

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

    const lunchPool = [
      ...(intent.water
        ? pool.filter((c) => isSeafoodPlace(c) && !used.has(c.id))
        : []),
      ...lunches.filter((c) => !used.has(c.id)),
      ...pool.filter(
        (c) => c.category === 'food' && !isCafePlace(c) && !used.has(c.id),
      ),
    ]
    const lunch = lunchPool[0]
    if (lunch) used.add(lunch.id)
    const lunchFamily = lunch ? cuisineFamily(lunch) : ''

    const dinnerPool = [
      ...(intent.water
        ? pool.filter(
            (c) =>
              isSeafoodPlace(c) &&
              !used.has(c.id) &&
              cuisineFamily(c) !== lunchFamily,
          )
        : []),
      ...dinners.filter(
        (c) =>
          !used.has(c.id) &&
          cuisineFamily(c) !== lunchFamily &&
          (c.rating ?? 0) >= 4,
      ),
      ...dinners.filter(
        (c) => !used.has(c.id) && cuisineFamily(c) !== lunchFamily,
      ),
      ...pubs.filter((c) => !used.has(c.id) && cuisineFamily(c) !== lunchFamily),
      ...dinners.filter((c) => !used.has(c.id)),
      ...pubs.filter((c) => !used.has(c.id)),
    ]
    const dinner = dinnerPool[0]
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
        const usedSlots = new Set<string>([dest.id])
        pushUnique(addSteps, usedSlots, meals.cafe, slots.cafe, 'Morning café')
        pushUnique(addSteps, usedSlots, pit, slots.sight, 'Viewpoint on the way')
        if (dest.category === 'sights' || dest.category === 'nature') {
          pushUnique(
            addSteps,
            usedSlots,
            dest,
            slots.sight && !pit ? slots.sight : slots.afternoon || slots.lunch || slots.dinner,
            'Main day-trip stop',
          )
        }
        pushUnique(addSteps, usedSlots, meals.lunch, slots.lunch, 'Lunch')
        pushUnique(
          addSteps,
          usedSlots,
          meals.dinner,
          slots.dinner,
          meals.dinner && isPubPlace(meals.dinner) ? 'Evening pub' : 'Dinner',
        )
        if (addSteps.length) {
          options.push({
            id: 'local-drive-day',
            label: 'Drive day plan',
            kind: 'itinerary',
            summary: `Drive toward ${dest.name} with meals timed to the route.`,
            rationale: 'Empty drive day: vehicle → scenic stop → destination → meals.',
            patch: withClearedBases({
              addSteps,
              addDrives: drivesForFarSteps(addSteps),
            }),
          })
        }
      }
      // Stay-local alternative
      if (sightsNear[0] || foodAll[0]) {
        const meals = pickMeals(false)
        const fun = sightsNear[0] || sights[0]
        const steps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        const usedLocal = new Set<string>()
        pushUnique(steps, usedLocal, meals.cafe, slots.cafe, 'Café near base')
        pushUnique(steps, usedLocal, fun, slots.sight, 'Stay-local highlight')
        pushUnique(steps, usedLocal, meals.lunch, slots.lunch, 'Lunch')
        if (steps.length) {
          options.push({
            id: 'local-stay-near',
            label: 'Stay near base',
            kind: 'highlight',
            summary: fun
              ? `Local day around ${fun.name}`
              : 'Keep the day closer to your start.',
            rationale: 'Alternative to driving far — useful if energy is low.',
            patch: patchWithDrives(steps),
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
          patch: patchWithDrives(
            views.slice(0, 2).map((p, i) => ({
              candidateId: p.id,
              start: i === 0 ? '10:30' : '16:00',
            })),
          ),
        })
      }
    }

    if (intent.water) {
      const waterMain = waters[0] || sights.find(isWaterPlace)
      const water2 =
        waters.find(
          (w) =>
            w.id !== waterMain?.id &&
            (!waterMain || placeDedupeKey(w) !== placeDedupeKey(waterMain)),
        ) ||
        sights.find(
          (s) =>
            isWaterPlace(s) &&
            s.id !== waterMain?.id &&
            (!waterMain || placeDedupeKey(s) !== placeDedupeKey(waterMain)),
        )
      const meals = pickMeals(Boolean(waterMain && waterMain.distKm >= 6))
      if (waterMain) {
        const waterSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        const used = new Set<string>([waterMain.id, placeDedupeKey(waterMain)])
        pushUnique(waterSteps, used, meals.cafe, slots.cafe, 'Morning café')
        pushUnique(waterSteps, used, waterMain, slots.sight, 'By the water')
        pushUnique(waterSteps, used, meals.lunch, slots.lunch, 'Lunch')
        pushUnique(
          waterSteps,
          used,
          water2,
          slots.afternoon,
          'Waterfront / lakeside stop',
        )
        pushUnique(
          waterSteps,
          used,
          meals.dinner,
          slots.dinner,
          meals.dinner && isSeafoodPlace(meals.dinner)
            ? 'Seafood dinner'
            : meals.dinner && isPubPlace(meals.dinner)
              ? 'Evening pub'
              : 'Dinner',
        )
        const byIdLocal = new Map(candidates.map((c) => [c.id, c]))
        if (uniquePlaceCount(waterSteps, byIdLocal) >= 2) {
          options.push({
            id: 'local-water-day',
            label: 'Day by the water',
            kind: 'itinerary',
            summary: water2
              ? `${waterMain.name} + ${water2.name}`
              : `Time by the water at ${waterMain.name}`,
            rationale:
              'Water ask: beach/lake/marina/waterfront stops with varied meals (not two pizzerias).',
            patch: patchWithDrives(waterSteps),
          })
        }
      }
    }

    if (intent.wine) {
      const tasting = wines[0]
      const fun =
        sightsNear.find((s) => s.id !== tasting?.id) ||
        sights.find((s) => s.id !== tasting?.id) ||
        views.find((v) => v.id !== tasting?.id)
      const fun2 =
        sights.find(
          (s) =>
            s.id !== fun?.id &&
            s.id !== tasting?.id &&
            (!fun || placeDedupeKey(s) !== placeDedupeKey(fun)),
        ) ||
        views.find((v) => v.id !== fun?.id && v.id !== tasting?.id)
      const meals = pickMeals(Boolean(tasting && tasting.distKm >= 5))
      // Full sightseeing/fill day with a tasting stop — not a dedicated “wine day” mode
      const pairWithDay =
        intent.fill || intent.fun || intent.city || intent.generic
      if (tasting) {
        const wineSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        const used = new Set<string>([tasting.id, placeDedupeKey(tasting)])
        if (pairWithDay || fill === 'empty') {
          pushUnique(wineSteps, used, meals.cafe, slots.cafe, 'Morning café')
          pushUnique(wineSteps, used, fun, slots.sight, 'Sightseeing')
          pushUnique(wineSteps, used, meals.lunch, slots.lunch, 'Lunch')
        }
        if (slots.afternoon || slots.sight) {
          wineSteps.push({
            candidateId: tasting.id,
            start: slots.afternoon || slots.sight || slots.dinner || '15:00',
            note: 'Wine tasting',
          })
        }
        if (pairWithDay || fill === 'empty') {
          pushUnique(wineSteps, used, fun2, slots.afternoon, 'Afternoon sight')
          pushUnique(
            wineSteps,
            used,
            meals.dinner,
            slots.dinner,
            meals.dinner && isPubPlace(meals.dinner)
              ? 'Evening pub'
              : 'Dinner',
          )
        }
        const byId = new Map(candidates.map((c) => [c.id, c]))
        const distinct = uniquePlaceCount(wineSteps, byId)
        const wantFull = pairWithDay || fill === 'empty'
        if (distinct >= (wantFull ? 2 : 1)) {
          options.push({
            id: 'local-wine-day',
            label:
              wantFull && distinct >= 2
                ? intent.city
                  ? 'City day + tasting'
                  : 'Fill day + tasting'
                : 'Wine tasting',
            kind: 'itinerary',
            summary:
              fun && wantFull && distinct >= 2
                ? `${fun.name} + tasting at ${tasting.name}`
                : `Wine tasting at ${tasting.name}`,
            rationale:
              'Wine as one stop in a normal sightseeing/meal day — distinct places only.',
            patch: patchWithDrives(wineSteps),
          })
        }
      }
    }

    if (intent.fill || intent.fun || intent.generic || intent.food || !body.userMessage.trim()) {
      const meals = pickMeals(false)
      const fun =
        (intent.water ? waters[0] : null) ||
        sightsNear[0] ||
        sights[0] ||
        views[0] ||
        sightsFar[0]
      const fun2 =
        (intent.water
          ? waters.find(
              (w) =>
                w.id !== fun?.id &&
                (!fun || placeDedupeKey(w) !== placeDedupeKey(fun)),
            )
          : null) ||
        sights.find(
          (s) => s.id !== fun?.id && (!fun || placeDedupeKey(s) !== placeDedupeKey(fun)),
        ) ||
        views.find((v) => v.id !== fun?.id)
      const wantActivity =
        intent.fill || intent.fun || intent.generic || intent.wine || intent.water || !intent.food
      const fillSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
      const used = new Set<string>()
      if (meals.cafe) pushUnique(fillSteps, used, meals.cafe, slots.cafe, 'Morning café')
      if (fun && wantActivity) {
        pushUnique(fillSteps, used, fun, slots.sight, 'Fun thing in the area')
      }
      if (meals.lunch) pushUnique(fillSteps, used, meals.lunch, slots.lunch, 'Lunch')
      if (fun2 && (intent.fill || intent.fun || intent.generic || intent.wine || intent.water)) {
        pushUnique(fillSteps, used, fun2, slots.afternoon, 'Afternoon activity')
      }
      if (meals.dinner) {
        pushUnique(
          fillSteps,
          used,
          meals.dinner,
          slots.dinner,
          isPubPlace(meals.dinner) ? 'High-rated pub' : 'Dinner',
        )
      }
      if (meals.nightcap) {
        pushUnique(
          fillSteps,
          used,
          meals.nightcap,
          slots.dinner ? addMinutesHm(slots.dinner, 105) : undefined,
          'Pub after dinner',
        )
      }
      const byId = new Map(candidates.map((c) => [c.id, c]))
      if (
        fillSteps.length >= 2 &&
        uniquePlaceCount(fillSteps, byId) >= 2
      ) {
        options.push({
          id: 'local-fill-day',
          label: intent.water
            ? 'Day by the water'
            : intent.city
              ? 'City day out'
              : 'Fill the day',
          kind: 'itinerary',
          summary: fun && wantActivity
            ? `Café, ${fun.name}, lunch & dinner`
            : 'Café, lunch and dinner arc',
          rationale:
            'Empty-day fill with café + activity + meals — distinct places only.',
          patch: patchWithDrives(fillSteps),
        })
      }

      if (sights[0] && sights[1]) {
        options.push({
          id: 'local-must-see',
          label: 'Must-see pack',
          kind: 'highlight',
          summary: `${sights[0].name} & ${sights[1].name}`,
          rationale: 'Two top sights/nature stops if you want activity-first.',
          patch: patchWithDrives([
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
          ]),
        })
      } else if (sights[0]) {
        options.push({
          id: 'local-must-see',
          label: `See ${sights[0].name}`.slice(0, 40),
          kind: 'highlight',
          summary: `Activity: ${sights[0].name}`,
          rationale: 'Single strong sight/nature stop.',
          patch: patchWithDrives([
            {
              candidateId: sights[0].id,
              start: '11:00',
              note: 'Must-see',
            },
          ]),
        })
      }

      // Meal-only shelf only when the ask is food-focused (not fill/fun/sights)
      if (
        (intent.food || intent.generic) &&
        !intent.fill &&
        !intent.fun &&
        !intent.wine
      ) {
        const mealsOnly = pickMeals(false)
        const mealSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
        if (mealsOnly.cafe) {
          mealSteps.push({
            candidateId: mealsOnly.cafe.id,
            start: '09:00',
            note: 'Morning café',
          })
        }
        if (mealsOnly.lunch) {
          mealSteps.push({
            candidateId: mealsOnly.lunch.id,
            start: '13:00',
            note: 'Lunch',
          })
        }
        if (mealsOnly.dinner) {
          mealSteps.push({
            candidateId: mealsOnly.dinner.id,
            start: '19:30',
            note: isPubPlace(mealsOnly.dinner) ? 'Pub' : 'Dinner',
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
            patch: patchWithDrives(mealSteps),
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
          patch: patchWithDrives([
            {
              candidateId: pick.id,
              start: idx === 0 ? '11:00' : '15:30',
              note: 'Fun thing in the area',
            },
          ]),
        })
      })
    }

    if (intent.wine && wines[0]) {
      const tasting = wines[0]
      const sight = sightsNear[0] || sights[0]
      const wineSteps: NonNullable<AiCoachOption['patch']['addSteps']> = []
      if (sight && (intent.fun || intent.fill)) {
        wineSteps.push({
          candidateId: sight.id,
          start: '11:00',
          note: 'Sight before tasting',
        })
      }
      wineSteps.push({
        candidateId: tasting.id,
        start: '15:00',
        note: 'Wine tasting',
      })
      options.push({
        id: 'local-wine-partial',
        label: `Taste at ${tasting.name}`.slice(0, 40),
        kind: 'highlight',
        summary: sight
          ? `${sight.name} + ${tasting.name}`
          : `Wine tasting: ${tasting.name}`,
        rationale: 'Partial-day wine add; pairs with a sight when asked.',
        patch: patchWithDrives(wineSteps),
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
          patch: patchWithDrives(gapSteps.slice(0, 3)),
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
        patch: patchWithDrives([{ candidateId: views[0].id, start: '16:00' }]),
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
      patch: patchWithDrives([{ candidateId: a.id, start: '11:00' }]),
    })
    if (b) {
      options.push({
        id: 'local-b',
        label: `Add ${b.name}`.slice(0, 40),
        kind:
          explorePlaceToItemType(b) === 'restaurant' ? 'food' : 'highlight',
        summary: b.summary || `${b.distKm.toFixed(1)} km away`,
        rationale: 'Second alternative stop.',
        patch: patchWithDrives([{ candidateId: b.id, start: '15:00' }]),
      })
    }
  }

  const withBasesCleared =
    fill === 'empty' && dayPlaceholders.length
      ? options.map((o) => {
          if (!(o.patch.addSteps?.length || o.patch.addDrives?.length)) return o
          return { ...o, patch: withClearedBases(o.patch) }
        })
      : options

  return diversifyByKind(dedupeOptions(withBasesCleared), 5)
}

function optionIsMealOnly(
  o: AiCoachOption,
  byId: Map<string, ExplorePlace>,
): boolean {
  const steps = o.patch.addSteps ?? []
  if (!steps.length) return false
  return steps.every((s) => {
    const c = byId.get(s.candidateId)
    return Boolean(c && (c.category === 'food' || c.category === 'drink'))
  })
}

/** Empty day or explicit fill/fun ⇒ user expects more than a single stop. */
function wantsFullDayPlan(
  body: AiCoachRequestBody,
  intent: CoachIntent,
): boolean {
  const fill =
    body.dayFillLevel ?? (body.thinDay ? 'empty' : 'partial')
  return (
    intent.fill ||
    intent.fun ||
    intent.water ||
    fill === 'empty' ||
    intent.generic
  )
}

function pickOpenCandidate(
  pool: ExplorePlace[],
  used: Set<string>,
  day: string,
  hm: string,
): ExplorePlace | undefined {
  return (
    pool.find((p) => !used.has(p.id) && placeOpenFor(p, day, hm)) ||
    pool.find((p) => !used.has(p.id))
  )
}

function repairJunkOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): AiCoachOption[] {
  const intent = detectCoachIntent(body.userMessage)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const fullDay = wantsFullDayPlan(body, intent)
  return options.filter((o) => {
    const steps = o.patch.addSteps ?? []
    if (!steps.length) return true
    if (o.kind === 'trim' || o.kind === 'pacing') return true

    const distinct = uniquePlaceCount(steps, byId)

    // Full day must not be the same venue at three clock times
    if (fullDay && distinct < 2) return false
    if (fullDay && (intent.fill || intent.fun || intent.wine) && distinct < 2) {
      return false
    }

    // Single café/restaurant/winery is never enough for a full/empty day
    if (fullDay && steps.length === 1) {
      const c = byId.get(steps[0]!.candidateId)
      if (!c || c.category === 'food' || c.category === 'drink') return false
    }

    // Meal/wine stack with no sight on a full/empty day
    if (fullDay && optionIsMealOnly(o, byId) && !optionHasSight(o, byId)) {
      return false
    }

    // Wine + full day must include a sight (tasting alone or tasting+meals is not enough)
    if (
      intent.wine &&
      fullDay &&
      optionHasWine(o, byId) &&
      !optionHasSight(o, byId)
    ) {
      return false
    }

    // Wine ask with no wine stop — drop meal-only substitutes
    if (
      intent.wine &&
      !optionHasWine(o, byId) &&
      optionIsMealOnly(o, byId)
    ) {
      return false
    }

    // Water ask with no water-oriented stop on a full day
    if (
      intent.water &&
      fullDay &&
      !optionHasWater(o, byId) &&
      (optionIsMealOnly(o, byId) || !optionHasSight(o, byId))
    ) {
      return false
    }

    return true
  })
}

/**
 * Deterministic repair + critique for one propose pass.
 * Auto-fixes cheap issues (drive without stop, missing drives, inject sights/meals);
 * collects the rest for a revise call.
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
  const fullDay = wantsFullDayPlan(body, intent)
  const vehicle = body.dayItems.find((i) => i.isVehicleStop)
  const hotel = body.dayItems.find((i) => i.type === 'hotel')
  const dayStartId = vehicle?.id ?? hotel?.id
  const avail = body.dayAvailability ?? {
    earliestStart: null as string | null,
    inTransitAllDay: false,
    notes: [] as string[],
  }
  const postArrival = avail.inTransitAllDay
    ? {}
    : slotsAfterArrival(avail.earliestStart)
  const issues: string[] = []
  const out: AiCoachOption[] = []
  const sightPool = candidates
    .filter(
      (c) =>
        (c.category === 'sights' || c.category === 'nature') && !isWinePlace(c),
    )
    .sort((a, b) => {
      if (intent.water) {
        const aw = isWaterPlace(a) ? 1 : 0
        const bw = isWaterPlace(b) ? 1 : 0
        if (aw !== bw) return bw - aw
      }
      return rankSight(a, b)
    })
  const waterPool = candidates.filter(isWaterPlace).sort(rankSight)
  const winePool = candidates.filter(isWinePlace).sort(rankFood)
  const lunchPool = candidates
    .filter(
      (c) =>
        c.category === 'food' &&
        !isCafePlace(c) &&
        !isPubPlace(c) &&
        !isWinePlace(c),
    )
    .sort((a, b) => {
      if (intent.water) {
        const as = isSeafoodPlace(a) ? 1 : 0
        const bs = isSeafoodPlace(b) ? 1 : 0
        if (as !== bs) return bs - as
      }
      return rankFood(a, b)
    })
  const dinnerPool = candidates
    .filter((c) => isDinnerPlace(c) && !isWinePlace(c))
    .sort((a, b) => {
      if (intent.water) {
        const as = isSeafoodPlace(a) ? 1 : 0
        const bs = isSeafoodPlace(b) ? 1 : 0
        if (as !== bs) return bs - as
      }
      return rankFood(a, b)
    })
  const cafePool = candidates
    .filter((c) => isCafePlace(c) && !isWinePlace(c))
    .sort(rankFood)

  for (const raw of options) {
    const opt: AiCoachOption = {
      ...raw,
      patch: {
        ...raw.patch,
        addSteps: dedupeAddStepsByPlace(
          [...(raw.patch.addSteps ?? [])],
          byId,
        ),
        addDrives: [...(raw.patch.addDrives ?? [])],
        setTimes: [...(raw.patch.setTimes ?? [])],
        removeSteps: [...(raw.patch.removeSteps ?? [])],
      },
    }
    const steps = opt.patch.addSteps ?? []
    const drives = opt.patch.addDrives ?? []

    // Transit gate: drop stops/drives scheduled before arrival (or wipe fills on in-transit days)
    if (avail.inTransitAllDay) {
      if (steps.length || drives.length) {
        issues.push(
          `Option "${opt.label}": day is fully in transit — remove sightseeing/meal stops until arrival day.`,
        )
        opt.patch.addSteps = []
        opt.patch.addDrives = []
      }
    } else if (avail.earliestStart) {
      const gate = avail.earliestStart
      const before = (opt.patch.addSteps ?? []).filter(
        (s) => s.start && s.start < gate,
      )
      if (before.length) {
        issues.push(
          `Option "${opt.label}": ${before.length} stop(s) before arrival gate ${gate} — removed or need retiming after transit.`,
        )
        opt.patch.addSteps = (opt.patch.addSteps ?? []).filter(
          (s) => !s.start || s.start >= gate,
        )
      }
      opt.patch.addDrives = (opt.patch.addDrives ?? []).filter((d) => {
        const t = d.start || d.end
        return !t || t >= gate
      })
    }

    const stepsAfterGate = opt.patch.addSteps ?? []
    const drivesAfterGate = opt.patch.addDrives ?? []
    const stepIds2 = new Set(stepsAfterGate.map((s) => s.candidateId))

    // Auto-repair: every drive destination must also be a stop (no revise needed)
    for (const d of drivesAfterGate) {
      if (stepIds2.has(d.toCandidateId)) continue
      if (!byId.has(d.toCandidateId)) {
        issues.push(
          `Option "${opt.label}": drive to unknown candidate ${d.toCandidateId} — remove or replace.`,
        )
        continue
      }
      const arrive = d.end || d.start || '12:00'
      if (avail.earliestStart && arrive < avail.earliestStart) continue
      stepsAfterGate.push({
        candidateId: d.toCandidateId,
        start: arrive,
        note: 'Stop at end of drive',
      })
      stepIds2.add(d.toCandidateId)
    }
    opt.patch.addSteps = stepsAfterGate
    opt.patch.addDrives = drivesAfterGate

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

    // Expand thin wine / empty-day options into a real day (sight + meals + tasting)
    if (
      fullDay &&
      opt.kind !== 'trim' &&
      opt.kind !== 'pacing' &&
      (intent.wine ||
        intent.water ||
        intent.fill ||
        intent.fun ||
        intent.generic ||
        fill === 'empty')
    ) {
      let adds = dedupeAddStepsByPlace(
        [...(opt.patch.addSteps ?? [])],
        byId,
      )
      const used = new Set(adds.map((s) => s.candidateId))
      const usedPlaceKeys = new Set(
        adds
          .map((s) => byId.get(s.candidateId))
          .filter(Boolean)
          .map((p) => placeDedupeKey(p!)),
      )
      const hasSight = () =>
        adds.some((s) => {
          const p = byId.get(s.candidateId)
          return Boolean(
            p &&
              (p.category === 'sights' || p.category === 'nature') &&
              !isWinePlace(p),
          )
        })
      const hasWine = () =>
        adds.some((s) => {
          const p = byId.get(s.candidateId)
          return Boolean(p && isWinePlace(p))
        })
      const hasWater = () =>
        adds.some((s) => {
          const p = byId.get(s.candidateId)
          return Boolean(p && isWaterPlace(p))
        })
      const hasLunchish = () =>
        adds.some((s) => {
          const t = s.start || ''
          const p = byId.get(s.candidateId)
          return (
            t >= '11:30' &&
            t < '16:00' &&
            Boolean(p && p.category === 'food' && !isWinePlace(p))
          )
        })
      const hasDinnerish = () =>
        adds.some((s) => {
          const t = s.start || ''
          const p = byId.get(s.candidateId)
          return (
            t >= '18:00' &&
            Boolean(p && !isWinePlace(p) && isDinnerPlace(p))
          )
        })

      const insertChrono = (
        candidateId: string,
        start: string | undefined,
        note: string,
      ) => {
        if (!start) return
        if (used.has(candidateId)) return
        const place = byId.get(candidateId)
        if (place) {
          const key = placeDedupeKey(place)
          if (usedPlaceKeys.has(key)) return
          usedPlaceKeys.add(key)
        }
        used.add(candidateId)
        adds.push({ candidateId, start, note })
        adds.sort((a, b) => (a.start || '').localeCompare(b.start || ''))
      }

      if (intent.water && !hasWater() && waterPool.length) {
        const t = postArrival.sight || postArrival.afternoon || postArrival.lunch
        const inject = t
          ? pickOpenCandidate(waterPool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'By the water')
      }
      if (!hasSight() && sightPool.length) {
        const t = postArrival.sight || postArrival.afternoon || postArrival.lunch
        const inject = t
          ? pickOpenCandidate(sightPool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'Sightseeing stop')
      }
      if (!hasLunchish() && lunchPool.length) {
        const t = postArrival.lunch
        const inject = t
          ? pickOpenCandidate(lunchPool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'Lunch')
      } else if (!hasLunchish() && cafePool.length && adds.length <= 1) {
        const t = postArrival.cafe
        const inject = t
          ? pickOpenCandidate(cafePool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'Morning café')
      }
      if (intent.wine && !hasWine() && winePool.length) {
        const t =
          postArrival.afternoon || postArrival.sight || postArrival.dinner
        const inject = t
          ? pickOpenCandidate(winePool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'Wine tasting')
      }
      if (!hasDinnerish() && dinnerPool.length) {
        const t = postArrival.dinner
        if (t) {
          const lunchStep = adds.find((s) => {
            const st = s.start || ''
            return st >= '11:30' && st < '16:00'
          })
          const lunchPlace = lunchStep
            ? byId.get(lunchStep.candidateId)
            : undefined
          const lunchFamily = lunchPlace ? cuisineFamily(lunchPlace) : ''
          const diverse =
            dinnerPool.find(
              (c) =>
                !used.has(c.id) &&
                cuisineFamily(c) !== lunchFamily &&
                placeOpenFor(c, body.day, t),
            ) || pickOpenCandidate(dinnerPool, used, body.day, t)
          if (diverse) {
            insertChrono(
              diverse.id,
              t,
              isSeafoodPlace(diverse)
                ? 'Seafood dinner'
                : isPubPlace(diverse)
                  ? 'Evening pub'
                  : 'Dinner',
            )
          }
        }
      } else if (hasLunchish() && hasDinnerish()) {
        const lunchStep = adds.find((s) => {
          const t = s.start || ''
          return t >= '11:30' && t < '16:00'
        })
        const dinnerStep = adds.find((s) => (s.start || '') >= '18:00')
        const lunchPlace = lunchStep
          ? byId.get(lunchStep.candidateId)
          : undefined
        const dinnerPlace = dinnerStep
          ? byId.get(dinnerStep.candidateId)
          : undefined
        if (
          lunchPlace &&
          dinnerPlace &&
          dinnerStep &&
          cuisineFamily(lunchPlace) === cuisineFamily(dinnerPlace) &&
          cuisineFamily(lunchPlace) !== 'other'
        ) {
          const alt = dinnerPool.find(
            (c) =>
              !used.has(c.id) &&
              cuisineFamily(c) !== cuisineFamily(lunchPlace) &&
              placeOpenFor(c, body.day, dinnerStep.start || '19:30'),
          )
          if (alt) {
            used.delete(dinnerStep.candidateId)
            const old = byId.get(dinnerStep.candidateId)
            if (old) usedPlaceKeys.delete(placeDedupeKey(old))
            dinnerStep.candidateId = alt.id
            dinnerStep.note = isSeafoodPlace(alt)
              ? 'Seafood dinner'
              : 'Dinner'
            used.add(alt.id)
            usedPlaceKeys.add(placeDedupeKey(alt))
          }
        }
      }

      // Second sight on wine/fill/water when we still look thin
      if (
        (intent.wine || intent.fill || intent.fun || intent.water) &&
        adds.length < 4 &&
        sightPool.length
      ) {
        const t = postArrival.afternoon
        const inject = t
          ? pickOpenCandidate(sightPool, used, body.day, t)
          : undefined
        if (inject && t) insertChrono(inject.id, t, 'Afternoon sight')
      }

      opt.patch.addSteps = adds

      if (intent.wine && !hasWine()) {
        issues.push(
          `Option "${opt.label}": wine ask needs a winery/wine-cellar candidate stop.`,
        )
      }
      if (intent.water && !hasWater()) {
        issues.push(
          `Option "${opt.label}": water ask needs a beach/lake/marina/waterfront stop.`,
        )
      }
      if (
        !hasSight() &&
        (intent.fun || intent.fill || intent.wine || intent.water)
      ) {
        issues.push(
          `Option "${opt.label}": full/empty day must include a sights/nature stop — not tasting or meals alone.`,
        )
      }
    }

    // Full day must not collapse to one venue at multiple hours
    if (fullDay && opt.kind !== 'trim' && opt.kind !== 'pacing') {
      const adds = opt.patch.addSteps ?? []
      if (uniquePlaceCount(adds, byId) < 2 && adds.length > 1) {
        issues.push(
          `Option "${opt.label}": uses the same place more than once — pick distinct candidates for café, sights, meals, and tasting.`,
        )
        // Keep a single stop rather than a fake multi-stop day
        opt.patch.addSteps = adds.slice(0, 1)
      }
    }

    // Rebuild drives as a stop→stop chain (not a star from the hotel)
    {
      const adds = opt.patch.addSteps ?? []
      if (adds.length) {
        const openArea =
          intent.drive ||
          Boolean(vehicle) ||
          /provence|luberon|tuscany|countryside|vineyard|winery|village/i.test(
            body.userMessage,
          ) ||
          candidates.some((c) => c.distKm >= 8)
        opt.patch.addDrives = chainDrivesForSteps(adds, candidates, {
          dayItems: [],
          fromItemId: dayStartId,
          openArea,
        })
      } else {
        opt.patch.addDrives = []
      }
    }

    // Empty fill: lone café/winery after expansion is still junk → revise
    if (fullDay) {
      const adds = opt.patch.addSteps ?? []
      if (adds.length <= 1 && opt.kind !== 'trim' && opt.kind !== 'pacing') {
        issues.push(
          `Option "${opt.label}": empty/full day must not be a single stop — include sight + meals (and wine tasting if asked) with distinct places.`,
        )
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

/** Expand/repair first, then drop options that are still too thin. */
export function finalizeCoachOptions(
  body: AiCoachRequestBody,
  candidates: ExplorePlace[],
  options: AiCoachOption[],
): AiCoachOption[] {
  const repaired = critiqueAndRepairOptions(body, candidates, options)
  const cleaned = repairJunkOptions(body, candidates, repaired.options)
  if (cleaned.length) {
    return diversifyByKind(dedupeOptions(cleaned), 5).slice(0, 5)
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
