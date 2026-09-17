import { describe, expect, it } from 'vitest'
import { blankPlanPlaceEnrichment, type TripItem, type TripRecord } from '../domain/types'
import {
  JOURNEY_SECTION_TITLE,
  ensurePlanScaffold,
  promotePlanPlaceToStep,
  reconcileJourneyAndPlan,
  unschedulePlanPlace,
} from './planBoard'
import { createId, nowIso } from './db'

function baseTrip(items: TripItem[]): TripRecord {
  return {
    id: 'TRIP1',
    meta: {
      name: 'Test',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
    },
    items,
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function sight(partial: Partial<TripItem> & Pick<TripItem, 'id' | 'title' | 'date'>): TripItem {
  return {
    type: 'sight',
    place: partial.title,
    city: '',
    endDate: '',
    start: '',
    end: '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency: 'EUR',
    status: 'planned',
    notes: '',
    url: '',
    tags: [],
    lat: 43.6,
    lon: 5.4,
    latTo: null,
    lonTo: null,
    wikidata: '',
    osmId: '',
    rating: null,
    googleMapsUri: '',
    geocodeQuery: '',
    updatedAt: nowIso(),
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
    ...partial,
  }
}

describe('reconcileJourneyAndPlan', () => {
  it('mirrors journey steps into matching day buckets', () => {
    const trip = ensurePlanScaffold(
      baseTrip([
        sight({ id: 'X1', title: 'Calanques', date: '2026-06-01' }),
        sight({ id: 'X2', title: 'Vieux Port', date: '2026-06-02' }),
      ]),
    )
    expect(trip.planSections.some((s) => s.title === JOURNEY_SECTION_TITLE)).toBe(true)
    const d1 = trip.planPlaces.filter((p) => p.scheduledDay === '2026-06-01')
    const d2 = trip.planPlaces.filter((p) => p.scheduledDay === '2026-06-02')
    expect(d1).toHaveLength(1)
    expect(d1[0]?.linkedItemId).toBe('X1')
    expect(d1[0]?.name).toBe('Calanques')
    expect(d2[0]?.linkedItemId).toBe('X2')
  })

  it('is idempotent when already synced', () => {
    const once = ensurePlanScaffold(
      baseTrip([sight({ id: 'X1', title: 'A', date: '2026-06-01' })]),
    )
    const twice = reconcileJourneyAndPlan(once)
    expect(twice.planPlaces.map((p) => p.id)).toEqual(once.planPlaces.map((p) => p.id))
    expect(twice.planPlaces[0]?.linkedItemId).toBe('X1')
  })

  it('scheduling a plan idea creates a journey step', () => {
    let trip = ensurePlanScaffold(baseTrip([]))
    const sectionId = trip.planSections[0]!.id
    trip = {
      ...trip,
      planPlaces: [
        {
          id: createId('PP'),
          sectionId,
          name: 'Bouillabaisse',
          place: '',
          city: 'Marseille',
          notes: '',
          lat: 43.29,
          lon: 5.37,
          url: '',
          googleMapsUri: '',
          osmId: '',
          scheduledDay: '',
          dayOrder: null,
          linkedItemId: '',
          ...blankPlanPlaceEnrichment(),
        },
      ],
    }
    const placeId = trip.planPlaces[0]!.id
    trip = promotePlanPlaceToStep(trip, placeId, '2026-06-01')
    expect(trip.items.some((i) => i.title === 'Bouillabaisse' && i.date === '2026-06-01')).toBe(
      true,
    )
    expect(trip.planPlaces.find((p) => p.id === placeId)?.linkedItemId).toBeTruthy()
  })

  it('unscheduling removes the linked journey step', () => {
    let trip = ensurePlanScaffold(
      baseTrip([sight({ id: 'X9', title: 'Drop me', date: '2026-06-01' })]),
    )
    const place = trip.planPlaces.find((p) => p.linkedItemId === 'X9')!
    trip = unschedulePlanPlace(trip, place.id)
    expect(trip.items.find((i) => i.id === 'X9')).toBeUndefined()
    expect(trip.planPlaces.find((p) => p.id === place.id)?.scheduledDay).toBe('')
  })
})
