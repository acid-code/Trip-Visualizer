import { describe, expect, it } from 'vitest'
import {
  briefingToPlanningHints,
  compileLodgingBrief,
  compileTripDayBriefing,
} from './context/compileDayBriefing'
import type { TripRecord } from '../domain/types'
import { setPlaceProvider } from './placeProvider'

function baseTrip(): TripRecord {
  return {
    id: 'T1',
    meta: {
      name: 'Test',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: 'slow food',
      plannerPrefs: { pace: 'soft', maxWalkKm: 1.5 },
    },
    items: [
      {
        id: 'H1',
        type: 'hotel',
        title: 'Area Inn',
        place: 'Nice',
        city: 'Nice',
        date: '2026-06-01',
        endDate: '2026-06-04',
        start: '',
        end: '',
        from: '',
        to: '',
        confirm: '',
        cost: null,
        currency: '',
        status: 'booked',
        notes: '',
        url: '',
        tags: [],
        lat: 43.7,
        lon: 7.26,
        latTo: null,
        lonTo: null,
        wikidata: '',
        osmId: '',
        rating: null,
        googleMapsUri: '',
        geocodeQuery: '',
        updatedAt: '',
        enrichmentSummary: '',
        enrichmentImage: '',
        enrichmentSource: '',
        routeCoords: [],
        source: 'app',
      },
    ],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  }
}

describe('compileTripDayBriefing', () => {
  it('includes lodging and prefs hints', () => {
    setPlaceProvider('osm')
    const b = compileTripDayBriefing(baseTrip(), '2026-06-02')
    expect(b.lodging.tonight?.title).toBe('Area Inn')
    expect(b.lodging.morningBase).toBe('same_hotel')
    expect(b.tripMemory.pace).toBe('soft')
    const hints = briefingToPlanningHints(b)
    expect(hints.some((h) => /Never propose specific hotel/i.test(h))).toBe(true)
    expect(hints.some((h) => /Walk cap/i.test(h))).toBe(true)
  })

  it('compileLodgingBrief marks checkout', () => {
    const trip = baseTrip()
    const lodging = compileLodgingBrief(trip.items, '2026-06-04')
    expect(lodging.checkoutToday).toBe(true)
  })
})
