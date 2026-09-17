import type { ItemType, PlanPlace, PlanSection, TripItem, TripRecord } from '../domain/types'
import { PLAN_SECTION_COLORS } from '../domain/types'
import { createId, nowIso, sortItems } from './db'
import { isPlaceholderBase } from './dayBases'
import { isValidCoord } from './validate'

export const DEFAULT_PLAN_SECTIONS: Array<Omit<PlanSection, 'id'>> = [
  { title: 'Must see', color: PLAN_SECTION_COLORS[0], icon: '⭐', order: 0 },
  { title: 'Food', color: PLAN_SECTION_COLORS[1], icon: '🍽️', order: 1 },
  { title: 'Stay ideas', color: PLAN_SECTION_COLORS[3], icon: '🛏️', order: 2 },
  { title: 'Maybe', color: PLAN_SECTION_COLORS[4], icon: '💭', order: 3 },
]

/** Section that holds mirrors of Journey steps (auto-synced). */
export const JOURNEY_SECTION_TITLE = 'On the trip'

const MAYBE_SECTION_TITLE = 'Maybe'

function ensureMaybeSection(sections: PlanSection[]): PlanSection[] {
  if (sections.some((s) => s.title.toLowerCase() === MAYBE_SECTION_TITLE.toLowerCase())) {
    return sections
  }
  const order = Math.max(0, ...sections.map((s) => s.order), 0) + 1
  return [
    ...sections,
    {
      id: createId('SEC'),
      title: MAYBE_SECTION_TITLE,
      color: PLAN_SECTION_COLORS[4],
      icon: '💭',
      order,
    },
  ]
}

export function ensurePlanScaffold(trip: TripRecord): TripRecord {
  const base = trip.planSections?.length
    ? trip.planSections
    : DEFAULT_PLAN_SECTIONS.map((s) => ({ ...s, id: createId('SEC') }))
  const sections = ensureMaybeSection(base)
  const scaffolded: TripRecord = {
    ...trip,
    planSections: sections,
    planPlaces: trip.planPlaces ?? [],
  }
  return reconcileJourneyAndPlan(scaffolded)
}

export function sectionForPlace(
  sections: PlanSection[],
  place: PlanPlace,
): PlanSection | undefined {
  return sections.find((s) => s.id === place.sectionId)
}

function inferTypeFromSection(section?: PlanSection): ItemType {
  const t = (section?.title || '').toLowerCase()
  if (t.includes('food') || t.includes('eat') || t.includes('restaurant')) return 'restaurant'
  if (t.includes('hotel') || t.includes('stay') || t.includes('sleep')) return 'hotel'
  if (t.includes('view') || t.includes('sight') || t.includes('must')) return 'sight'
  if (t.includes('activ')) return 'activity'
  return 'sight'
}

function ensureJourneySection(trip: TripRecord): { trip: TripRecord; sectionId: string } {
  const existing = trip.planSections.find(
    (s) =>
      s.title === JOURNEY_SECTION_TITLE ||
      s.title.toLowerCase() === 'journey' ||
      s.title.toLowerCase() === 'on the trip',
  )
  if (existing) return { trip, sectionId: existing.id }
  const section: PlanSection = {
    id: createId('SEC'),
    title: JOURNEY_SECTION_TITLE,
    color: '#38bdf8',
    icon: '🗺️',
    order: Math.max(0, ...trip.planSections.map((s) => s.order)) + 1,
  }
  return {
    trip: { ...trip, planSections: [...trip.planSections, section] },
    sectionId: section.id,
  }
}

function placeFromItem(
  item: TripItem,
  sectionId: string,
  dayOrder: number,
  existing?: PlanPlace,
): PlanPlace {
  return {
    id: existing?.id ?? createId('PP'),
    sectionId: existing?.sectionId || sectionId,
    name: item.title || item.place || existing?.name || 'Step',
    place: item.place || existing?.place || '',
    city: item.city || existing?.city || '',
    notes: item.notes || existing?.notes || '',
    lat: item.lat ?? existing?.lat ?? null,
    lon: item.lon ?? existing?.lon ?? null,
    url: item.url || existing?.url || '',
    googleMapsUri: item.googleMapsUri || existing?.googleMapsUri || '',
    osmId: item.osmId || existing?.osmId || '',
    scheduledDay: item.date,
    // Keep Plan bucket order when the user reordered in Days — don't wipe it
    // every time Journey reconcile runs.
    dayOrder: existing?.dayOrder != null ? existing.dayOrder : dayOrder,
    linkedItemId: item.id,
  }
}

function itemFromPlace(
  trip: TripRecord,
  place: PlanPlace,
  day: string,
  section?: PlanSection,
): TripItem {
  return {
    id: createId('X'),
    type: inferTypeFromSection(section),
    title: place.name,
    place: place.place || place.name,
    city: place.city,
    date: day,
    endDate: '',
    start: '',
    end: '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency: trip.meta.homeCurrency,
    status: 'planned',
    notes: place.notes,
    url: place.url || place.googleMapsUri,
    tags: ['from-plan'],
    lat: place.lat,
    lon: place.lon,
    latTo: null,
    lonTo: null,
    wikidata: '',
    osmId: place.osmId,
    rating: null,
    googleMapsUri: place.googleMapsUri,
    geocodeQuery: place.name,
    updatedAt: nowIso(),
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
  }
}

/**
 * Keep Journey steps and Plan day buckets in lockstep:
 * - every non-placeholder dated TripItem → PlanPlace on the same day (linked)
 * - every scheduled PlanPlace without a link → TripItem on that day
 * - linked pairs stay field-synced; orphan mirrors are dropped
 */
export function reconcileJourneyAndPlan(trip: TripRecord): TripRecord {
  const { trip: withSection, sectionId: journeySectionId } = ensureJourneySection(trip)
  const liveItems = sortItems(
    withSection.items.filter((i) => !isPlaceholderBase(i) && Boolean(i.date)),
  )
  const liveIds = new Set(liveItems.map((i) => i.id))

  const isJourneySection = (sectionId: string) => {
    const s = withSection.planSections.find((x) => x.id === sectionId)
    if (!s) return false
    const t = s.title.toLowerCase()
    return s.title === JOURNEY_SECTION_TITLE || t === 'journey' || t === 'on the trip'
  }

  // Drop auto mirrors whose step is gone; demote promoted ideas back to the board
  let places = (withSection.planPlaces ?? []).flatMap((p) => {
    if (!p.linkedItemId || liveIds.has(p.linkedItemId)) return [p]
    if (isJourneySection(p.sectionId)) return []
    return [{ ...p, linkedItemId: '', scheduledDay: '', dayOrder: null }]
  })

  const byLink = new Map(
    places.filter((p) => p.linkedItemId).map((p) => [p.linkedItemId, p] as const),
  )

  const dayOrders = new Map<string, number>()
  const mirrored: PlanPlace[] = []
  const seenPlaceIds = new Set<string>()

  for (const item of liveItems) {
    const order = dayOrders.get(item.date) ?? 0
    dayOrders.set(item.date, order + 1)
    const existing = byLink.get(item.id)
    const nextPlace = placeFromItem(item, journeySectionId, order, existing)
    mirrored.push(nextPlace)
    seenPlaceIds.add(nextPlace.id)
    byLink.set(item.id, nextPlace)
  }

  for (const p of places) {
    if (seenPlaceIds.has(p.id)) continue
    if (p.linkedItemId && liveIds.has(p.linkedItemId)) continue
    mirrored.push(p)
  }

  let items = [...withSection.items]
  places = mirrored.map((p) => {
    if (!p.scheduledDay) return p
    if (p.linkedItemId && liveIds.has(p.linkedItemId)) return p
    // Scheduled idea → create Journey step
    const section = sectionForPlace(withSection.planSections, p)
    const order = dayOrders.get(p.scheduledDay) ?? 0
    dayOrders.set(p.scheduledDay, order + 1)
    const item = itemFromPlace(withSection, p, p.scheduledDay, section)
    items.push(item)
    return { ...p, linkedItemId: item.id, dayOrder: p.dayOrder ?? order }
  })

  const prevById = new Map((withSection.planPlaces ?? []).map((p) => [p.id, p]))
  const placesChanged =
    places.length !== (withSection.planPlaces?.length ?? 0) ||
    places.some((p) => {
      const prev = prevById.get(p.id)
      return (
        !prev ||
        prev.scheduledDay !== p.scheduledDay ||
        prev.linkedItemId !== p.linkedItemId ||
        prev.dayOrder !== p.dayOrder ||
        prev.name !== p.name ||
        prev.lat !== p.lat ||
        prev.lon !== p.lon ||
        prev.sectionId !== p.sectionId
      )
    })
  const itemsChanged = items.length !== withSection.items.length
  const sectionsChanged = withSection.planSections !== trip.planSections

  if (!placesChanged && !itemsChanged && !sectionsChanged) return withSection

  return {
    ...withSection,
    items,
    planPlaces: places,
    updatedAt: nowIso(),
  }
}

/** One-way promote: PlanPlace → TripItem on a day. Links via linkedItemId. */
export function promotePlanPlaceToStep(
  trip: TripRecord,
  placeId: string,
  day: string,
): TripRecord {
  const place = trip.planPlaces.find((p) => p.id === placeId)
  if (!place) return trip
  const section = sectionForPlace(trip.planSections, place)
  const dayPlaces = trip.planPlaces.filter((p) => p.scheduledDay === day)
  const dayOrder = place.dayOrder ?? dayPlaces.length

  let items = [...trip.items]
  let linkedId = place.linkedItemId
  if (linkedId) {
    items = items.map((it) =>
      it.id === linkedId
        ? {
            ...it,
            title: place.name,
            place: place.place || place.name,
            city: place.city,
            notes: place.notes,
            date: day,
            lat: place.lat,
            lon: place.lon,
            url: place.url || place.googleMapsUri,
            googleMapsUri: place.googleMapsUri,
            osmId: place.osmId,
            updatedAt: nowIso(),
          }
        : it,
    )
  } else {
    const item = itemFromPlace(trip, place, day, section)
    linkedId = item.id
    items.push(item)
  }

  const planPlaces = trip.planPlaces.map((p) =>
    p.id === placeId
      ? { ...p, scheduledDay: day, dayOrder, linkedItemId: linkedId || p.linkedItemId }
      : p,
  )

  return reconcileJourneyAndPlan({ ...trip, items, planPlaces, updatedAt: nowIso() })
}

/** Remove from a day bucket; keep as an idea and drop the linked Journey step. */
export function unschedulePlanPlace(trip: TripRecord, placeId: string): TripRecord {
  const place = trip.planPlaces.find((p) => p.id === placeId)
  if (!place) return trip
  const items = place.linkedItemId
    ? trip.items.filter((i) => i.id !== place.linkedItemId)
    : trip.items
  return reconcileJourneyAndPlan({
    ...trip,
    items,
    planPlaces: trip.planPlaces.map((p) =>
      p.id === placeId
        ? { ...p, scheduledDay: '', dayOrder: null, linkedItemId: '' }
        : p,
    ),
    updatedAt: nowIso(),
  })
}

/** Delete a plan place and its linked Journey step (if any). */
export function removePlanPlace(trip: TripRecord, placeId: string): TripRecord {
  const place = trip.planPlaces.find((p) => p.id === placeId)
  if (!place) return trip
  const items = place.linkedItemId
    ? trip.items.filter((i) => i.id !== place.linkedItemId)
    : trip.items
  return reconcileJourneyAndPlan({
    ...trip,
    items,
    planPlaces: trip.planPlaces.filter((p) => p.id !== placeId),
    updatedAt: nowIso(),
  })
}

export function addPlanPlace(
  trip: TripRecord,
  input: {
    sectionId: string
    name: string
    place?: string
    city?: string
    lat?: number | null
    lon?: number | null
    notes?: string
    url?: string
    googleMapsUri?: string
    osmId?: string
  },
): TripRecord {
  const place: PlanPlace = {
    id: createId('PP'),
    sectionId: input.sectionId,
    name: input.name,
    place: input.place || '',
    city: input.city || '',
    notes: input.notes || '',
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    url: input.url || '',
    googleMapsUri: input.googleMapsUri || '',
    osmId: input.osmId || '',
    scheduledDay: '',
    dayOrder: null,
    linkedItemId: '',
  }
  return {
    ...trip,
    planPlaces: [...trip.planPlaces, place],
    updatedAt: nowIso(),
  }
}

/** Match an unscheduled list idea by name + coords (one list at a time). */
function findSimilarListPlace(
  trip: TripRecord,
  opts: { name: string; lat?: number | null; lon?: number | null },
): PlanPlace | undefined {
  const name = opts.name.trim().toLowerCase()
  return trip.planPlaces.find((p) => {
    if (p.scheduledDay || p.linkedItemId) return false
    if (p.name.trim().toLowerCase() !== name) return false
    if (
      opts.lat != null &&
      opts.lon != null &&
      p.lat != null &&
      p.lon != null &&
      (Math.abs(p.lat - opts.lat) > 0.0008 || Math.abs(p.lon - opts.lon) > 0.0008)
    ) {
      return false
    }
    return true
  })
}

/**
 * Add to a list section, or move an existing unscheduled idea there.
 * A place lives in only one Discover list at a time.
 */
export function upsertPlanPlaceToSection(
  trip: TripRecord,
  input: {
    sectionId: string
    name: string
    place?: string
    city?: string
    lat?: number | null
    lon?: number | null
    notes?: string
    url?: string
    googleMapsUri?: string
    osmId?: string
  },
): { trip: TripRecord; moved: boolean; created: boolean; sectionTitle: string } {
  const section = trip.planSections.find((s) => s.id === input.sectionId)
  const sectionTitle = section?.title || 'list'
  const existing = findSimilarListPlace(trip, input)
  if (existing) {
    if (existing.sectionId === input.sectionId) {
      return { trip, moved: false, created: false, sectionTitle }
    }
    return {
      trip: {
        ...trip,
        planPlaces: trip.planPlaces.map((p) =>
          p.id === existing.id
            ? {
                ...p,
                sectionId: input.sectionId,
                place: input.place || p.place,
                notes: input.notes || p.notes,
                googleMapsUri: input.googleMapsUri || p.googleMapsUri,
                osmId: input.osmId || p.osmId,
                lat: input.lat ?? p.lat,
                lon: input.lon ?? p.lon,
              }
            : p,
        ),
        updatedAt: nowIso(),
      },
      moved: true,
      created: false,
      sectionTitle,
    }
  }
  return {
    trip: addPlanPlace(trip, input),
    moved: false,
    created: true,
    sectionTitle,
  }
}

/** Resolve Must see / Food / Stay ideas / Maybe from explore category. */
export function planSectionForExploreCategory(
  trip: TripRecord,
  cat: string,
): PlanSection | undefined {
  const want =
    cat === 'food' || cat === 'drink'
      ? 'food'
      : cat === 'hotel'
        ? 'stay'
        : cat === 'nature' || cat === 'sights' || cat === 'activity' || cat === 'other'
          ? 'must'
          : 'maybe'
  return trip.planSections.find((s) => {
    const t = s.title.toLowerCase()
    if (want === 'food') return t.includes('food') || t.includes('eat')
    if (want === 'stay') return t.includes('stay') || t.includes('hotel')
    if (want === 'must') return t.includes('must') || t.includes('sight')
    return t.includes('maybe') || t.includes('optional')
  })
}

export function planMaybeSection(trip: TripRecord): PlanSection | undefined {
  return trip.planSections.find((s) => {
    const t = s.title.toLowerCase()
    return t.includes('maybe') || t.includes('optional')
  })
}

export function reorderDayPlaces(
  trip: TripRecord,
  day: string,
  orderedIds: string[],
): TripRecord {
  const order = new Map(orderedIds.map((id, i) => [id, i]))
  const planPlaces = trip.planPlaces.map((p) =>
    p.scheduledDay === day && order.has(p.id)
      ? { ...p, dayOrder: order.get(p.id)! }
      : p,
  )

  // Keep Journey step list order in sync (sortItems uses date + start).
  const items = trip.items.map((it) => {
    const place = planPlaces.find(
      (p) => p.linkedItemId === it.id && p.scheduledDay === day,
    )
    if (!place || !order.has(place.id)) return it
    const i = order.get(place.id)!
    const mins = 9 * 60 + i * 30
    const hh = String(Math.floor(mins / 60)).padStart(2, '0')
    const mm = String(mins % 60).padStart(2, '0')
    return { ...it, date: day, start: `${hh}:${mm}`, updatedAt: nowIso() }
  })

  return {
    ...trip,
    items,
    planPlaces,
    updatedAt: nowIso(),
  }
}

/** Nearest-neighbor day order optimization (greedy). */
export function optimizeDayRoute(trip: TripRecord, day: string): TripRecord {
  const dayPlaces = trip.planPlaces
    .filter((p) => p.scheduledDay === day && isValidCoord(p.lat, p.lon))
    .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
  if (dayPlaces.length < 3) return trip

  const remaining = [...dayPlaces]
  const ordered: PlanPlace[] = [remaining.shift()!]
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

  return reorderDayPlaces(
    trip,
    day,
    ordered.map((p) => p.id),
  )
}

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

/** Rough drive minutes between consecutive scheduled places (~40 km/h urban). */
export function dayTravelLegs(
  trip: TripRecord,
  day: string,
): Array<{ fromId: string; toId: string; km: number; minutes: number }> {
  const places = trip.planPlaces
    .filter((p) => p.scheduledDay === day && isValidCoord(p.lat, p.lon))
    .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
  const legs: Array<{ fromId: string; toId: string; km: number; minutes: number }> = []
  for (let i = 0; i < places.length - 1; i++) {
    const a = places[i]!
    const b = places[i + 1]!
    const km = haversineKm(
      { lat: a.lat!, lon: a.lon! },
      { lat: b.lat!, lon: b.lon! },
    )
    legs.push({
      fromId: a.id,
      toId: b.id,
      km: Math.round(km * 10) / 10,
      minutes: Math.max(5, Math.round((km / 40) * 60)),
    })
  }
  return legs
}
