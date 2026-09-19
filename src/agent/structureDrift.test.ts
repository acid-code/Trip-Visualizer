import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import {
  formatStructureTime,
  formatTripStructureText,
} from './formatTripStructure'
import {
  draftFromLiveTrip,
  fingerprintLiveTrip,
  reconcileStructureDrift,
  wantsVisibleShape,
} from './structureDrift'
import type { FullTripDraft } from './types'

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

function baseTrip(
  over?: Partial<TripRecord['meta']> & { items?: TripItem[] },
): TripRecord {
  return {
    id: 'T1',
    meta: {
      name: 'Provence',
      startDate: '2026-06-01',
      endDate: '2026-06-04',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: '',
      plannerPrefs: {},
      ...over,
    },
    items: over?.items || [],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  }
}

function draftFixture(over?: Partial<FullTripDraft>): FullTripDraft {
  return {
    summary: 'Sun and stone towns',
    spine: {
      id: 's1',
      label: 'Nice → Aix',
      summary: 'Coast then inland',
      why: 'Fits your pace',
      openQuestions: [],
      areas: [
        {
          label: 'Nice',
          roughNights: 2,
          transportHint: 'transit_ok',
          theme: 'Promenade',
          why: 'Arrival city',
        },
        {
          label: 'Aix-en-Provence',
          roughNights: 2,
          transportHint: 'car_useful',
          theme: 'Markets',
          why: 'Inland calm',
        },
      ],
    },
    dayPlan: [
      {
        date: '2026-06-01',
        areaLabel: 'Nice',
        theme: 'Promenade',
        why: 'Land and unwind',
        highlights: [{ name: 'Promenade des Anglais', why: 'Easy first walk' }],
      },
      {
        date: '2026-06-02',
        areaLabel: 'Nice',
        theme: 'Old town',
        highlights: [],
      },
      {
        date: '2026-06-03',
        areaLabel: 'Aix-en-Provence',
        theme: 'Markets',
        highlights: [],
      },
      {
        date: '2026-06-04',
        areaLabel: 'Aix-en-Provence',
        theme: 'Cours Mirabeau',
        highlights: [],
      },
    ],
    planPlaceNames: [],
    items: [],
    openQuestions: [],
    decisions: [{ what: 'Start in Nice', why: 'Your flight lands there' }],
    ...over,
  }
}

describe('formatTripStructureText', () => {
  it('includes route, stay zones, and timestamp', () => {
    const text = formatTripStructureText(draftFixture(), baseTrip(), {
      sketchedAt: Date.parse('2026-09-19T18:00:00Z'),
    })
    expect(text).toContain('Nice → Aix')
    expect(text).toContain('Why this route: Fits your pace')
    expect(text).toContain('Stay zones:')
    expect(text).toContain('Nice stay-zone')
    expect(text).toContain('Promenade des Anglais')
    expect(text).toMatch(/sketched /i)
    expect(formatStructureTime(Date.parse('2026-09-19T18:00:00Z'))).toBeTruthy()
  })
})

describe('reconcileStructureDrift', () => {
  it('returns none when Journey matches the sketch', () => {
    const trip = baseTrip({
      items: [
        item({
          id: 'B1',
          title: 'Nice base',
          place: 'Nice',
          city: 'Nice',
          date: '2026-06-01',
          tags: ['day-base', 'placeholder', 'from-full-trip-ai'],
        }),
      ],
    })
    expect(reconcileStructureDrift(draftFixture(), trip).kind).toBe('none')
  })

  it('auto-syncs when a day shell moves to another spine area', () => {
    const trip = baseTrip({
      items: [
        item({
          id: 'B1',
          title: 'Aix-en-Provence base',
          place: 'Aix-en-Provence',
          city: 'Aix-en-Provence',
          date: '2026-06-01',
          tags: ['day-base', 'placeholder', 'from-full-trip-ai'],
        }),
      ],
    })
    const r = reconcileStructureDrift(draftFixture(), trip)
    expect(r.kind).toBe('auto')
    if (r.kind !== 'auto') return
    expect(r.draft.dayPlan.find((d) => d.date === '2026-06-01')?.areaLabel).toBe(
      'Aix-en-Provence',
    )
  })

  it('asks when Journey jumps to a city outside the spine', () => {
    const trip = baseTrip({
      items: [
        item({
          id: 'B1',
          title: 'Lyon base',
          place: 'Lyon',
          city: 'Lyon',
          date: '2026-06-01',
          tags: ['day-base', 'placeholder'],
        }),
      ],
    })
    const r = reconcileStructureDrift(draftFixture(), trip)
    expect(r.kind).toBe('ask')
    if (r.kind !== 'ask') return
    expect(r.questions[0]).toMatch(/Lyon/)
  })

  it('asks on large date-range shifts', () => {
    const trip = baseTrip({
      startDate: '2026-07-01',
      endDate: '2026-07-14',
    })
    const r = reconcileStructureDrift(draftFixture(), trip)
    expect(r.kind).toBe('ask')
    if (r.kind !== 'ask') return
    expect(r.questions.some((q) => /dates/i.test(q))).toBe(true)
  })

  it('fingerprints change when day shells change', () => {
    const a = fingerprintLiveTrip(baseTrip())
    const b = fingerprintLiveTrip(
      baseTrip({
        items: [
          item({
            id: 'B1',
            title: 'Nice base',
            place: 'Nice',
            city: 'Nice',
            date: '2026-06-01',
            tags: ['day-base', 'placeholder'],
          }),
        ],
      }),
    )
    expect(a).not.toBe(b)
  })
})

describe('draftFromLiveTrip / wantsVisibleShape', () => {
  it('detects shape intents', () => {
    expect(wantsVisibleShape('show me a draft of the current trip')).toBe(true)
    expect(wantsVisibleShape('can you return a shape that i can see?')).toBe(
      true,
    )
    expect(wantsVisibleShape('what hotels fit Nice?')).toBe(false)
  })

  it('mirrors day shells into a draft tip', () => {
    const trip = baseTrip({
      items: [
        item({
          id: 'B1',
          title: 'Avignon base',
          place: 'Avignon',
          city: 'Avignon',
          date: '2026-06-01',
          tags: ['day-base', 'placeholder'],
        }),
        item({
          id: 'B2',
          title: 'Aix base',
          place: 'Aix',
          city: 'Aix',
          date: '2026-06-02',
          tags: ['day-base', 'placeholder'],
        }),
        item({
          id: 'B3',
          title: 'Aix base',
          place: 'Aix',
          city: 'Aix',
          date: '2026-06-03',
          tags: ['day-base', 'placeholder'],
        }),
        item({
          id: 'B4',
          title: 'Aix base',
          place: 'Aix',
          city: 'Aix',
          date: '2026-06-04',
          tags: ['day-base', 'placeholder'],
        }),
        item({
          id: 'S1',
          type: 'sight',
          title: 'Pont d’Avignon',
          city: 'Avignon',
          date: '2026-06-01',
        }),
      ],
    })
    const draft = draftFromLiveTrip(trip)
    expect(draft).not.toBeNull()
    expect(draft!.dayPlan.length).toBe(4)
    expect(draft!.spine.areas.map((a) => a.label)).toEqual(['Avignon', 'Aix'])
    expect(draft!.dayPlan[0]?.highlights.some((h) => /Pont/i.test(h.name))).toBe(
      true,
    )
  })
})
