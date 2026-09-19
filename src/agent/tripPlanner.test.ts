import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import { isPlaceholderBase } from '../data/dayBases'
import {
  allocateSpineToDays,
  applyFullTripDraft,
  applyItemUpdates,
  applySpineToTrip,
  type FullTripDraft,
  type TripSpineOption,
} from './index'

function emptyTrip(start = '2026-06-01', end = '2026-06-07'): TripRecord {
  return {
    id: 'T-full',
    meta: {
      name: '',
      startDate: start,
      endDate: end,
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: 'food + coast',
      plannerPrefs: {},
    },
    items: [],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  }
}

function flightItem(partial: Partial<TripItem> & { id: string }): TripItem {
  return {
    id: partial.id,
    type: 'flight',
    title: partial.title || 'Flight',
    place: partial.place || '',
    city: partial.city || '',
    date: partial.date || '2026-06-01',
    endDate: partial.endDate || '',
    start: partial.start || '',
    end: partial.end || '',
    from: partial.from || '',
    to: partial.to || '',
    confirm: '',
    cost: null,
    currency: 'EUR',
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
  }
}

const southFranceSpine: TripSpineOption = {
  id: 's1',
  label: 'Provence → Riviera',
  summary: 'Villages then coast',
  areas: [
    { label: 'Avignon', roughNights: 2, transportHint: 'transit_ok', theme: 'Provence base' },
    { label: 'Aix', roughNights: 2, transportHint: 'car_useful', theme: 'Markets' },
    { label: 'Nice', roughNights: 3, transportHint: 'walk_city', theme: 'Coast' },
  ],
  openQuestions: ['Car for Aix hops?'],
}

describe('allocateSpineToDays', () => {
  it('covers every calendar day with area stay-zones', () => {
    const days = allocateSpineToDays('2026-06-01', '2026-06-07', southFranceSpine.areas)
    expect(days).toHaveLength(7)
    expect(days.every((d) => d.areaLabel.length > 0)).toBe(true)
    expect(days[0]!.areaLabel).toBe('Avignon')
    expect(days[days.length - 1]!.areaLabel).toBe('Nice')
  })
})

describe('applyFullTripDraft — create full trip without hotels', () => {
  it('builds area day-bases, themes/highlights, plan seeds; never invents hotels', () => {
    const dayPlan = allocateSpineToDays(
      '2026-06-01',
      '2026-06-07',
      southFranceSpine.areas,
    ).map((d, i) =>
      i === 0
        ? {
            ...d,
            theme: 'Arrive & settle',
            why: 'Your arrival day — keep it light near the base',
            highlights: [
              {
                name: 'Palais des Papes',
                why: 'Iconic and walkable if you land midday',
              },
            ],
          }
        : d,
    )
    const draft: FullTripDraft = {
      summary: 'South France food + coast loop',
      titleSuggestion: 'Provence & Riviera',
      spine: {
        ...southFranceSpine,
        why: 'Food + coast without inventing hotels — villages then Riviera',
      },
      dayPlan,
      planPlaceNames: [
        {
          name: 'Cours Mirabeau',
          section: 'must',
          city: 'Aix',
          why: 'Classic Aix promenade for a food-focused vibe',
        },
        { name: 'Socca near port', section: 'food', city: 'Nice' },
      ],
      decisions: [
        {
          what: 'Avignon first',
          why: 'Gives you a soft landing before coast days',
        },
      ],
      items: [
        {
          type: 'flight',
          title: 'Arrive NCE',
          place: 'Nice Airport',
          city: 'Nice',
          date: '2026-06-01',
          confidence: 'medium',
          source: 'inferred',
          tentative: true,
        },
        {
          type: 'hotel',
          title: 'Invented Grand Hotel',
          place: 'Nice',
          city: 'Nice',
          date: '2026-06-05',
          confidence: 'low',
          source: 'inferred',
          tentative: true,
        },
      ],
      openQuestions: [],
    }

    const next = applyFullTripDraft(emptyTrip(), draft)

    expect(next.meta.name).toBe('Provence & Riviera')
    expect(next.meta.plannerPrefs?.adoptedAreas?.length).toBeGreaterThan(0)

    const hotels = next.items.filter((i) => i.type === 'hotel')
    expect(hotels.every(isPlaceholderBase)).toBe(true)
    expect(hotels.some((h) => /grand hotel/i.test(h.title))).toBe(false)
    expect(hotels.some((h) => h.tags?.includes('from-full-trip-ai'))).toBe(true)

    const flights = next.items.filter((i) => i.type === 'flight')
    expect(flights).toHaveLength(1)
    expect(flights[0]!.title).toBe('Arrive NCE')

    expect(next.items.some((i) => i.type === 'sight' && i.title === 'Palais des Papes')).toBe(
      true,
    )
    expect(
      next.items.some(
        (i) =>
          i.type === 'sight' &&
          i.title === 'Palais des Papes' &&
          /Why:.*midday/i.test(i.notes),
      ),
    ).toBe(true)
    expect(next.items.some((i) => i.type === 'note' && /arrive/i.test(i.title))).toBe(true)
    expect(
      next.planPlaces?.some(
        (p) => p.name === 'Cours Mirabeau' && /Why:.*Aix/i.test(p.notes),
      ),
    ).toBe(true)
  })

  it('updates existing flight in place and does not duplicate it', () => {
    const trip = emptyTrip()
    trip.items = [
      flightItem({
        id: 'F1',
        title: 'LHR to NCE',
        date: '2026-06-01',
        from: 'LHR',
        to: 'NCE',
      }),
    ]
    const draft: FullTripDraft = {
      summary: 'Around existing flight',
      spine: southFranceSpine,
      dayPlan: allocateSpineToDays('2026-06-01', '2026-06-07', southFranceSpine.areas),
      planPlaceNames: [],
      items: [
        {
          type: 'flight',
          title: 'LHR to NCE',
          place: '',
          city: '',
          date: '2026-06-01',
          from: 'LHR',
          to: 'NCE',
          start: '09:40',
          end: '12:55',
          confidence: 'high',
          source: 'user_text',
          tentative: false,
        },
      ],
      itemUpdates: [
        {
          itemId: 'F1',
          start: '09:40',
          end: '12:55',
          from: 'London Heathrow',
          to: 'Nice Airport',
        },
      ],
      openQuestions: [],
    }

    const next = applyFullTripDraft(trip, draft)
    const flights = next.items.filter((i) => i.type === 'flight')
    expect(flights).toHaveLength(1)
    expect(flights[0]!.id).toBe('F1')
    // Blank times get filled; already-set from/to stay (scrubbing an older tip must not clobber).
    expect(flights[0]!.start).toBe('09:40')
    expect(flights[0]!.end).toBe('12:55')
    expect(flights[0]!.from).toBe('LHR')
    expect(flights[0]!.to).toBe('NCE')
  })

  it('applyItemUpdates patches by id', () => {
    const trip = emptyTrip()
    trip.items = [flightItem({ id: 'F2', title: 'Outbound', date: '2026-06-01' })]
    const next = applyItemUpdates(trip, [
      { itemId: 'F2', start: '07:15', from: 'CDG', to: 'NCE' },
    ])
    expect(next.items[0]!.start).toBe('07:15')
    expect(next.items[0]!.from).toBe('CDG')
  })

  it('applySpineToTrip seeds bases from spine alone', () => {
    const next = applySpineToTrip(emptyTrip('2026-09-01', '2026-09-04'), southFranceSpine)
    const bases = next.items.filter(isPlaceholderBase)
    expect(bases.length).toBeGreaterThanOrEqual(4)
    expect(bases.every((b) => b.type === 'hotel' && b.tags?.includes('placeholder'))).toBe(
      true,
    )
    expect(bases.some((b) => /avignon|aix|nice/i.test(b.city || b.place))).toBe(true)
  })
})
