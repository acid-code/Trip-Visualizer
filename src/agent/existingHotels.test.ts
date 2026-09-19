import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import { sanitizeTripRecord } from '../domain/types'
import {
  alignDayPlanWithHotels,
  applyFullTripDraft,
  draftFromLiveTrip,
  existingHotelsBrief,
  hotelAreaForDate,
  type FullTripDraft,
  type TripSpineOption,
} from './index'

function item(
  partial: Partial<TripItem> & { id: string; date: string; title: string },
): TripItem {
  return {
    id: partial.id,
    type: partial.type || 'hotel',
    title: partial.title,
    place: partial.place || '',
    city: partial.city || '',
    date: partial.date,
    endDate: partial.endDate || partial.date,
    start: '',
    end: '',
    from: '',
    to: '',
    confirm: partial.confirm || '',
    cost: null,
    currency: 'EUR',
    status: 'planned',
    notes: '',
    url: '',
    tags: partial.tags || [],
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
  }
}

function trip(items: TripItem[]): TripRecord {
  return sanitizeTripRecord({
    id: 'T-hotels',
    meta: {
      name: 'Provence',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: '',
      plannerPrefs: {},
    },
    items,
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  })
}

describe('existing hotels as anchors', () => {
  it('briefs real hotels and ignores placeholders', () => {
    const t = trip([
      item({
        id: 'H1',
        title: 'Hôtel d’Europe',
        city: 'Avignon',
        place: '12 Place Crillon',
        date: '2026-06-01',
        endDate: '2026-06-03',
        confirm: 'ABC',
      }),
      item({
        id: 'B1',
        title: 'Avignon base',
        city: 'Avignon',
        date: '2026-06-01',
        tags: ['day-base', 'placeholder'],
      }),
    ])
    const hotels = existingHotelsBrief(t)
    expect(hotels).toHaveLength(1)
    expect(hotels[0]!.title).toMatch(/Europe/)
    expect(hotelAreaForDate(t, '2026-06-02')?.hotelTitle).toMatch(/Europe/)
  })

  it('alignDayPlanWithHotels forces booked city onto the sketch', () => {
    const t = trip([
      item({
        id: 'H1',
        title: 'Hôtel d’Europe',
        city: 'Avignon',
        date: '2026-06-01',
        endDate: '2026-06-02',
      }),
    ])
    const aligned = alignDayPlanWithHotels(t, [
      {
        date: '2026-06-01',
        areaLabel: 'Marseille',
        why: 'Wrong city',
      },
      {
        date: '2026-06-03',
        areaLabel: 'Aix',
        why: 'No hotel',
      },
    ])
    expect(aligned[0]?.areaLabel).toBe('Avignon')
    expect(aligned[0]?.why).toMatch(/Europe/)
    expect(aligned[1]?.areaLabel).toBe('Aix')
  })

  it('mirror + apply keep the real hotel and use its city', () => {
    const t = trip([
      item({
        id: 'H1',
        title: 'Hôtel d’Europe',
        city: 'Avignon',
        place: '12 Place Crillon',
        date: '2026-06-01',
        endDate: '2026-06-03',
      }),
    ])
    const mirrored = draftFromLiveTrip(t)
    expect(mirrored).not.toBeNull()
    expect(mirrored!.dayPlan.every((d) => d.areaLabel === 'Avignon')).toBe(true)
    expect(mirrored!.dayPlan[0]?.why).toMatch(/Europe/)

    const spine: TripSpineOption = {
      id: 's1',
      label: 'Wrong → Aix',
      summary: 's',
      areas: [
        { label: 'Marseille', roughNights: 2, transportHint: 'transit_ok' },
        { label: 'Aix', roughNights: 1, transportHint: 'walk_city' },
      ],
      openQuestions: [],
    }
    const badDraft: FullTripDraft = {
      summary: 'ignores hotel',
      spine,
      dayPlan: [
        {
          date: '2026-06-01',
          areaLabel: 'Marseille',
          theme: 'Coast',
          why: 'Nope',
          highlights: [],
        },
        {
          date: '2026-06-02',
          areaLabel: 'Marseille',
          theme: 'Coast',
          why: 'Nope',
          highlights: [],
        },
        {
          date: '2026-06-03',
          areaLabel: 'Aix',
          theme: 'Markets',
          why: 'Food',
          highlights: [],
        },
      ],
      planPlaceNames: [],
      items: [],
      openQuestions: [],
    }
    const next = applyFullTripDraft(t, badDraft)
    expect(next.items.some((i) => i.id === 'H1')).toBe(true)
    expect(next.items.find((i) => i.id === 'H1')!.title).toMatch(/Europe/)
    // Placeholder shells on hotel nights are left alone
    expect(
      next.items.filter(
        (i) =>
          i.type === 'hotel' &&
          i.tags?.includes('placeholder') &&
          /Marseille/i.test(i.title),
      ),
    ).toHaveLength(0)
  })
})
