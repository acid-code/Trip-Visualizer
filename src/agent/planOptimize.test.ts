import { describe, expect, it } from 'vitest'
import type { PlanPlace, TripRecord } from '../domain/types'
import { blankPlanPlaceEnrichment } from '../domain/types'
import { optimizePlanDay, classifyPlanPlace } from './planOptimize'
import { setPlaceProvider, getCachedPlaceProvider, clearPlaceProviderCache } from './placeProvider'

function place(
  id: string,
  name: string,
  lat: number,
  lon: number,
  dayOrder: number,
): PlanPlace {
  return {
    id,
    sectionId: 's1',
    name,
    place: name,
    city: 'Test',
    notes: '',
    lat,
    lon,
    url: '',
    googleMapsUri: '',
    osmId: '',
    scheduledDay: '2026-06-01',
    dayOrder,
    linkedItemId: '',
    ...blankPlanPlaceEnrichment(),
  }
}

function tripWithPlaces(planPlaces: PlanPlace[]): TripRecord {
  return {
    id: 'T1',
    meta: {
      name: 'Test',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: '',
      plannerPrefs: { maxWalkKm: 1.5 },
    },
    items: [],
    planSections: [],
    planPlaces,
    isExample: false,
    createdAt: '',
    updatedAt: '',
  }
}

describe('classifyPlanPlace', () => {
  it('detects cafe and dinner', () => {
    expect(classifyPlanPlace(place('1', 'Morning Café', 0, 0, 0))).toBe('cafe')
    expect(
      classifyPlanPlace(place('2', 'Romantic Dinner Restaurant', 0, 0, 0)),
    ).toBe('dinner')
  })
})

describe('optimizePlanDay', () => {
  it('puts cafe before dinner and returns ordered ids', () => {
    const places = [
      place('d', 'Dinner Spot Restaurant', 43.7, 7.26, 0),
      place('c', 'Coffee Café', 43.701, 7.261, 1),
      place('s', 'Old Town Museum', 43.702, 7.262, 2),
    ]
    const result = optimizePlanDay(tripWithPlaces(places), '2026-06-01')
    expect(result.kind).toBe('reorder')
    expect(result.orderedIds).toHaveLength(3)
    expect(result.orderedIds[0]).toBe('c')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('no-ops meaningfully for single place', () => {
    const result = optimizePlanDay(
      tripWithPlaces([place('a', 'Only', 43.7, 7.26, 0)]),
      '2026-06-01',
    )
    expect(result.orderedIds).toEqual(['a'])
  })
})

describe('placeProvider cache', () => {
  it('stores and clears provider', () => {
    clearPlaceProviderCache()
    expect(getCachedPlaceProvider()).toBeNull()
    setPlaceProvider('osm')
    expect(getCachedPlaceProvider()).toBe('osm')
    setPlaceProvider('google')
    expect(getCachedPlaceProvider()).toBe('google')
    clearPlaceProviderCache()
    expect(getCachedPlaceProvider()).toBeNull()
  })
})
