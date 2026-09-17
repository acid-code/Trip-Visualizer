import { describe, expect, it } from 'vitest'
import { blankPlanPlaceEnrichment, type TripRecord } from '../domain/types'
import {
  buildJourneyLayerRows,
  buildMyMapsLayers,
  buildPlanLayerRows,
  rowsToCsv,
} from './myMapsExport'

function sampleTrip(over: Partial<TripRecord> = {}): TripRecord {
  return {
    id: 'TRIP1',
    meta: {
      name: 'Paris',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      homeCurrency: 'USD',
      timezoneNote: '',
      notes: '',
      travelers: '',
    },
    items: [
      {
        id: 'I1',
        type: 'sight',
        title: 'Louvre',
        place: 'Rue de Rivoli',
        city: 'Paris',
        date: '2026-06-02',
        endDate: '',
        start: '10:00',
        end: '12:00',
        from: '',
        to: '',
        confirm: '',
        cost: null,
        currency: '',
        status: 'planned',
        notes: 'Morning',
        url: '',
        tags: [],
        lat: 48.8606,
        lon: 2.3376,
        latTo: null,
        lonTo: null,
        wikidata: '',
        osmId: '',
        rating: null,
        googleMapsUri: 'https://maps.google.com/?q=Louvre',
        geocodeQuery: '',
        updatedAt: '',
        enrichmentSummary: '',
        enrichmentImage: '',
        enrichmentSource: '',
        routeCoords: [],
        source: 'app',
      },
      {
        id: 'I2',
        type: 'restaurant',
        title: 'No coords',
        place: '',
        city: '',
        date: '2026-06-02',
        endDate: '',
        start: '',
        end: '',
        from: '',
        to: '',
        confirm: '',
        cost: null,
        currency: '',
        status: 'planned',
        notes: '',
        url: '',
        tags: [],
        lat: null,
        lon: null,
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
    planSections: [
      { id: 'SEC1', title: 'Must see', color: '#60a5fa', icon: '📍', order: 0 },
      { id: 'SEC2', title: 'Maybe', color: '#a78bfa', icon: '🤔', order: 1 },
      { id: 'SEC3', title: 'On the trip', color: '#34d399', icon: '🗓️', order: 2 },
    ],
    planPlaces: [
      {
        id: 'PP1',
        sectionId: 'SEC1',
        name: 'Eiffel Tower',
        place: 'Champ de Mars',
        city: 'Paris',
        notes: 'Sunset',
        lat: 48.8584,
        lon: 2.2945,
        url: '',
        googleMapsUri: 'https://maps.google.com/?q=Eiffel',
        osmId: '',
        scheduledDay: '',
        dayOrder: null,
        linkedItemId: '',
        ...blankPlanPlaceEnrichment(),
      },
      {
        id: 'PP2',
        sectionId: 'SEC2',
        name: 'Skip no pin',
        place: '',
        city: '',
        notes: '',
        lat: null,
        lon: null,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '',
        dayOrder: null,
        linkedItemId: '',
        ...blankPlanPlaceEnrichment(),
      },
      {
        id: 'PP3',
        sectionId: 'SEC3',
        name: 'Louvre mirror',
        place: '',
        city: 'Paris',
        notes: '',
        lat: 48.8606,
        lon: 2.3376,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '2026-06-02',
        dayOrder: 0,
        linkedItemId: 'I1',
        ...blankPlanPlaceEnrichment(),
      },
    ],
    isExample: false,
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

describe('myMapsExport', () => {
  it('builds plan rows from list sections only (skips On the trip)', () => {
    const rows = buildPlanLayerRows(sampleTrip())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: '📍 Eiffel Tower',
      section: 'Must see',
      lat: 48.8584,
      lon: 2.2945,
    })
    expect(rows.some((r) => r.name.includes('Louvre mirror'))).toBe(false)
  })

  it('builds journey rows with type emoji in the name', () => {
    const rows = buildJourneyLayerRows(sampleTrip())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: '🏛️ Louvre',
      type: 'sight',
      day: '2026-06-02',
    })
  })

  it('escapes CSV fields and includes header', () => {
    const csv = rowsToCsv([
      {
        name: 'Cafe, "Best"',
        lat: 1,
        lon: 2,
        description: 'line\nbreak',
        day: '',
        section: 'A',
        type: '',
        mapsUrl: '',
      },
    ])
    expect(csv.startsWith('Name,Latitude,Longitude')).toBe(true)
    expect(csv).toContain('"Cafe, ""Best"""')
    expect(csv).toContain('"line\nbreak"')
  })

  it('buildMyMapsLayers returns both CSVs with emojis', () => {
    const { plan, journey } = buildMyMapsLayers(sampleTrip())
    expect(plan.rows).toHaveLength(1)
    expect(journey.rows).toHaveLength(1)
    expect(plan.csv).toContain('📍 Eiffel Tower')
    expect(journey.csv).toContain('🏛️ Louvre')
  })
})
