import { describe, expect, it } from 'vitest'
import { blankPlanPlaceEnrichment, type PlanPlace, type TripRecord } from '../domain/types'
import { createId, nowIso } from './db'
import {
  buildTripWorkbook,
  linkImportedPlanPlacesToItems,
  parseTripWorkbook,
  resolvePlanImport,
  workbookToArrayBuffer,
} from './excel'
import { DEFAULT_PLAN_SECTIONS, JOURNEY_SECTION_TITLE } from './planBoard'

function sampleTrip(): TripRecord {
  const must = { ...DEFAULT_PLAN_SECTIONS[0]!, id: 'SEC_MUST' }
  const food = { ...DEFAULT_PLAN_SECTIONS[1]!, id: 'SEC_FOOD' }
  const journey = {
    id: 'SEC_JOURNEY',
    title: JOURNEY_SECTION_TITLE,
    color: '#38bdf8',
    icon: '🗺️',
    order: 99,
  }
  const stepId = 'STEP1'
  return {
    id: 'TRIP1',
    meta: {
      name: 'Provence',
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: 'slow food',
    },
    items: [
      {
        id: stepId,
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
        currency: 'EUR',
        status: 'planned',
        notes: '',
        url: '',
        tags: [],
        lat: 48.8606,
        lon: 2.3376,
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
    planSections: [must, food, journey],
    planPlaces: [
      {
        id: 'PP1',
        sectionId: must.id,
        name: 'Calanques',
        place: 'Casssis cliffs',
        city: 'Cassis',
        notes: 'morning hike',
        lat: 43.21,
        lon: 5.54,
        url: 'https://example.com/calanques',
        googleMapsUri: '',
        osmId: 'n1',
        scheduledDay: '',
        dayOrder: null,
        linkedItemId: '',
        ...blankPlanPlaceEnrichment(),
      },
      {
        id: 'PP2',
        sectionId: food.id,
        name: 'Bouillabaisse',
        place: 'Vieux Port',
        city: 'Marseille',
        notes: '',
        lat: 43.29,
        lon: 5.37,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '2026-06-03',
        dayOrder: 0,
        linkedItemId: '',
        ...blankPlanPlaceEnrichment(),
      },
      {
        id: 'PP_JOURNEY',
        sectionId: journey.id,
        name: 'Louvre',
        place: 'Rue de Rivoli',
        city: 'Paris',
        notes: '',
        lat: 48.8606,
        lon: 2.3376,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '2026-06-02',
        dayOrder: 0,
        linkedItemId: stepId,
        ...blankPlanPlaceEnrichment(),
      },
    ],
    isExample: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

describe('Excel Plan round-trip', () => {
  it('exports Plan ideas and restores them on import (skips Journey mirrors)', async () => {
    const buf = await workbookToArrayBuffer(buildTripWorkbook(sampleTrip()))
    const parsed = parseTripWorkbook(buf)

    expect(parsed.hasPlanSheet).toBe(true)
    expect(parsed.planPlaces.map((p) => p.name).sort()).toEqual(['Bouillabaisse', 'Calanques'])
    expect(parsed.planPlaces.some((p) => p.name === 'Louvre')).toBe(false)

    const cal = parsed.planPlaces.find((p) => p.name === 'Calanques')!
    expect(cal.city).toBe('Cassis')
    expect(cal.lat).toBeCloseTo(43.21, 2)
    expect(cal.lon).toBeCloseTo(5.54, 2)
    expect(cal.url).toContain('calanques')
    expect(cal.notes).toBe('morning hike')

    const food = parsed.planPlaces.find((p) => p.name === 'Bouillabaisse')!
    expect(food.scheduledDay).toBe('2026-06-03')
    expect(parsed.planSections.some((s) => s.title === 'Must see')).toBe(true)
    expect(parsed.planSections.some((s) => s.title === 'Food')).toBe(true)
  })

  it('links scheduled Plan ideas to matching Steps after import', () => {
    const places: PlanPlace[] = [
      {
        id: createId('PP'),
        sectionId: 'SEC_MUST',
        name: 'Louvre',
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
        linkedItemId: '',
        ...blankPlanPlaceEnrichment(),
      },
    ]
    const linked = linkImportedPlanPlacesToItems(places, sampleTrip().items)
    expect(linked[0]!.linkedItemId).toBe('STEP1')
  })

  it('keeps local Plan when Excel Plan sheet is empty (merge)', () => {
    const existing = sampleTrip()
    const resolved = resolvePlanImport({
      hasPlanSheet: true,
      planSections: [],
      planPlaces: [],
      existing,
    })
    expect(resolved.fromExcel).toBe(false)
    expect(resolved.planPlaces).toHaveLength(existing.planPlaces.length)
  })

  it('uses Excel Plan when it has ideas (backup restore)', () => {
    const existing = sampleTrip()
    const imported = existing.planPlaces.slice(0, 1)
    const resolved = resolvePlanImport({
      hasPlanSheet: true,
      planSections: existing.planSections,
      planPlaces: imported,
      existing,
    })
    expect(resolved.fromExcel).toBe(true)
    expect(resolved.planPlaces).toHaveLength(1)
    expect(resolved.planPlaces[0]!.name).toBe('Calanques')
  })
})
