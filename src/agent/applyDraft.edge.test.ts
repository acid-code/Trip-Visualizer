/**
 * Edge cases: scrubbing older drafts, restart/share, mirror — must not
 * delete Journey data or clobber user-edited step fields.
 */

import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import { sanitizeTripRecord } from '../domain/types'
import { isPlaceholderBase } from '../data/dayBases'
import {
  applyFullTripDraft,
  applyItemUpdates,
  draftFromLiveTrip,
  mergeTripDrafts,
  restartConversationForTrip,
  tripWithAiSketch,
  tripWithoutAiSketch,
  type FullTripDraft,
  type TripSpineOption,
} from './index'
import type { VersionStack } from './draftVersions'

function item(
  partial: Partial<TripItem> & { id: string; date: string; title: string },
): TripItem {
  return {
    id: partial.id,
    type: partial.type || 'sight',
    title: partial.title,
    place: partial.place || '',
    city: partial.city || '',
    date: partial.date,
    endDate: partial.endDate || '',
    start: partial.start || '',
    end: partial.end || '',
    from: partial.from || '',
    to: partial.to || '',
    confirm: '',
    cost: null,
    currency: 'EUR',
    status: partial.status || 'planned',
    notes: partial.notes || '',
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

function trip(over?: {
  items?: TripItem[]
  name?: string
  start?: string
  end?: string
}): TripRecord {
  return sanitizeTripRecord({
    id: 'T-edge',
    meta: {
      name: over?.name || 'Provence',
      startDate: over?.start || '2026-06-01',
      endDate: over?.end || '2026-06-04',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: 'romantic',
      plannerPrefs: { adoptedAreas: ['Avignon', 'Aix'] },
    },
    items: over?.items || [],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  })
}

const spine: TripSpineOption = {
  id: 's1',
  label: 'Avignon → Aix',
  summary: 'Short loop',
  areas: [
    { label: 'Avignon', roughNights: 2, transportHint: 'transit_ok', theme: 'Rhône' },
    { label: 'Aix', roughNights: 2, transportHint: 'walk_city', theme: 'Markets' },
  ],
  openQuestions: [],
}

function draftV(
  label: string,
  over?: Partial<FullTripDraft>,
): FullTripDraft {
  return {
    summary: label,
    spine: { ...spine, label },
    dayPlan: [
      {
        date: '2026-06-01',
        areaLabel: 'Avignon',
        theme: 'Arrive',
        why: 'Land soft',
        highlights: [{ name: 'Palais des Papes', why: 'Iconic' }],
      },
      {
        date: '2026-06-02',
        areaLabel: 'Avignon',
        theme: 'Wander',
        why: 'Old town',
        highlights: [],
      },
      {
        date: '2026-06-03',
        areaLabel: 'Aix',
        theme: 'Markets',
        why: 'Food',
        highlights: [{ name: 'Cours Mirabeau', why: 'Promenade' }],
      },
      {
        date: '2026-06-04',
        areaLabel: 'Aix',
        theme: 'Depart',
        why: 'Leave',
        highlights: [],
      },
    ],
    planPlaceNames: [],
    items: [],
    openQuestions: [],
    ...over,
  }
}

describe('apply older draft without clobbering user edits', () => {
  it('fills blank flight fields but keeps user times/title/from-to', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'My renamed flight',
          date: '2026-06-01',
          start: '11:30',
          end: '14:05',
          from: 'CDG',
          to: 'MRS',
          notes: 'Booked on United app',
        }),
      ],
    })
    const older = draftV('older tip', {
      itemUpdates: [
        {
          itemId: 'F1',
          title: 'Stale AI title',
          start: '09:00',
          end: '11:00',
          from: 'LHR',
          to: 'NCE',
          notes: 'AI guess',
        },
      ],
      items: [
        {
          type: 'flight',
          title: 'Duplicate outbound',
          place: '',
          city: '',
          date: '2026-06-01',
          from: 'LHR',
          to: 'NCE',
          confidence: 'medium',
          source: 'inferred',
          tentative: true,
        },
      ],
    })

    const next = applyFullTripDraft(live, older)
    const flights = next.items.filter((i) => i.type === 'flight')
    expect(flights).toHaveLength(1)
    expect(flights[0]!.id).toBe('F1')
    // Title / airports / notes stay; times may update from the tip (review before Save).
    expect(flights[0]!.title).toBe('My renamed flight')
    expect(flights[0]!.start).toBe('09:00')
    expect(flights[0]!.end).toBe('11:00')
    expect(flights[0]!.from).toBe('CDG')
    expect(flights[0]!.to).toBe('MRS')
    expect(flights[0]!.notes).toContain('Booked on United app')
    expect(flights[0]!.notes).not.toContain('AI guess')
  })

  it('still fills empty times from a draft update', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'Outbound',
          date: '2026-06-01',
          from: 'CDG',
          to: 'NCE',
        }),
      ],
    })
    const next = applyFullTripDraft(
      live,
      draftV('fill blanks', {
        itemUpdates: [{ itemId: 'F1', start: '08:15', end: '10:00' }],
      }),
    )
    expect(next.items.find((i) => i.id === 'F1')!.start).toBe('08:15')
    expect(next.items.find((i) => i.id === 'F1')!.end).toBe('10:00')
    expect(next.items.find((i) => i.id === 'F1')!.from).toBe('CDG')
  })

  it('keeps user-added sights unless removeItemIds was confirmed', () => {
    const live = trip({
      items: [
        item({
          id: 'U1',
          type: 'sight',
          title: 'My secret vineyard',
          city: 'Aix',
          date: '2026-06-03',
          notes: 'Reservation 17:00',
        }),
      ],
    })
    const next = applyFullTripDraft(live, draftV('apply structure'))
    expect(next.items.some((i) => i.id === 'U1')).toBe(true)
    expect(
      next.items.find((i) => i.id === 'U1')!.notes,
    ).toContain('Reservation 17:00')

    const removed = applyFullTripDraft(
      live,
      draftV('drop with consent', { removeItemIds: ['U1'] }),
    )
    expect(removed.items.some((i) => i.id === 'U1')).toBe(false)
  })

  it('does not overwrite a customized day-shell lodging title', () => {
    const live = trip({
      items: [
        item({
          id: 'B1',
          type: 'hotel',
          title: 'Maison du Chapelier',
          place: '12 Rue de la République',
          city: 'Avignon',
          date: '2026-06-01',
          endDate: '2026-06-01',
          tags: ['day-base', 'placeholder'],
        }),
      ],
    })
    const next = applyFullTripDraft(live, draftV('areas'))
    const shell = next.items.find((i) => i.id === 'B1')!
    expect(shell.title).toBe('Maison du Chapelier')
    expect(shell.place).toBe('12 Rue de la République')
  })

  it('protectFilled=false overwrites with non-empty values but never wipes with blanks', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'Keep title',
          date: '2026-06-01',
          start: '10:00',
          notes: 'Seat 12A',
          from: 'CDG',
        }),
      ],
    })
    const forced = applyItemUpdates(
      live,
      [{ itemId: 'F1', start: '06:00', title: 'Forced' }],
      { protectFilled: false },
    )
    expect(forced.items[0]!.start).toBe('06:00')
    expect(forced.items[0]!.title).toBe('Forced')
    expect(forced.items[0]!.notes).toBe('Seat 12A')

    const blankAttack = applyItemUpdates(
      live,
      [
        {
          itemId: 'F1',
          start: '07:00',
          title: '',
          notes: '',
          from: '',
        },
      ],
      { protectFilled: false },
    )
    expect(blankAttack.items[0]!.start).toBe('07:00')
    expect(blankAttack.items[0]!.title).toBe('Keep title')
    expect(blankAttack.items[0]!.notes).toBe('Seat 12A')
    expect(blankAttack.items[0]!.from).toBe('CDG')
  })

  it('time-only patch keeps confirm, notes, title, and airports', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'Coach-named flight',
          date: '2026-06-01',
          start: '09:00',
          end: '11:00',
          from: 'CDG',
          to: 'NCE',
          notes: 'Window seat',
        }),
      ],
    })
    // Simulate a confirm code the user added
    live.items[0]!.confirm = 'ABC123'
    live.items[0]!.tags = ['from-full-trip-ai']

    const next = applyFullTripDraft(
      live,
      draftV('times only', {
        itemUpdates: [
          {
            itemId: 'F1',
            start: '10:15',
            end: '12:20',
            title: '',
            notes: '',
            from: '',
            to: '',
          },
        ],
      }),
    )
    const f = next.items.find((i) => i.id === 'F1')!
    expect(f.start).toBe('10:15')
    expect(f.end).toBe('12:20')
    expect(f.title).toBe('Coach-named flight')
    expect(f.from).toBe('CDG')
    expect(f.to).toBe('NCE')
    expect(f.notes).toBe('Window seat')
    expect(f.confirm).toBe('ABC123')
    expect(f.tags).toContain('from-full-trip-ai')
  })
})

describe('restart / share / mirror must not wipe Journey', () => {
  it('restartConversation clears chat session only — trip items untouched', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'Flight to Paris',
          date: '2026-06-01',
        }),
        item({
          id: 'S1',
          title: 'Keep me',
          date: '2026-06-02',
        }),
      ],
    })
    const beforeIds = live.items.map((i) => i.id).sort()
    restartConversationForTrip(live)
    expect(live.items.map((i) => i.id).sort()).toEqual(beforeIds)
  })

  it('tripWithoutAiSketch drops sketches but keeps steps and prefs', () => {
    const stack: VersionStack = {
      versions: [
        {
          id: 'TV1',
          at: 1,
          label: 'v1',
          reason: 'r',
          mode: 'Ready to apply',
          draft: draftV('v1'),
          byUid: 'u1',
          byLabel: 'Asaf',
        },
      ],
      index: 0,
    }
    const withSketch = tripWithAiSketch(
      trip({
        items: [
          item({ id: 'S1', title: 'Stay', date: '2026-06-01' }),
        ],
      }),
      stack,
    )
    expect(withSketch.aiSketch?.versions).toHaveLength(1)
    const cleared = tripWithoutAiSketch(withSketch)
    expect(cleared.aiSketch).toBeUndefined()
    expect(cleared.items.some((i) => i.id === 'S1')).toBe(true)
    expect(cleared.meta.plannerPrefs?.adoptedAreas).toContain('Avignon')
  })

  it('mirror draft does not invent hotels or remove transit', () => {
    const live = trip({
      items: [
        item({
          id: 'F1',
          type: 'flight',
          title: 'CDG→MRS',
          date: '2026-06-01',
          from: 'CDG',
          to: 'MRS',
          start: '09:00',
        }),
        item({
          id: 'B1',
          type: 'hotel',
          title: 'Avignon base',
          city: 'Avignon',
          place: 'Avignon',
          date: '2026-06-01',
          endDate: '2026-06-01',
          tags: ['day-base', 'placeholder'],
        }),
      ],
    })
    const mirrored = draftFromLiveTrip(live)
    expect(mirrored).not.toBeNull()
    const applied = applyFullTripDraft(live, mirrored!)
    expect(applied.items.find((i) => i.id === 'F1')!.start).toBe('09:00')
    expect(applied.items.filter((i) => i.type === 'flight')).toHaveLength(1)
    expect(
      applied.items.filter((i) => i.type === 'hotel' && !isPlaceholderBase(i)),
    ).toHaveLength(0)
  })
})

describe('surgical draft merge edge cases', () => {
  it('one-day patch keeps other days and spine', () => {
    const prev = draftV('full')
    const next = mergeTripDrafts(prev, {
      ...prev,
      dayPlan: [
        {
          date: '2026-06-03',
          areaLabel: 'Aix',
          theme: 'Birthday dinner',
          special: true,
          why: 'Touch only this day',
          highlights: [{ name: 'Le Formal', why: 'Reservation' }],
        },
      ],
    })
    expect(next.dayPlan).toHaveLength(4)
    expect(next.dayPlan[0]?.theme).toBe('Arrive')
    expect(next.dayPlan[2]?.theme).toBe('Birthday dinner')
    expect(next.dayPlan[2]?.special).toBe(true)
    expect(next.spine.areas).toHaveLength(2)
  })
})
