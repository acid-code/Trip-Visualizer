import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import { sanitizeTripRecord } from '../domain/types'
import {
  applyFullTripDraft,
  gateDraftRemovals,
  userAffirmedRemovals,
  userDeclinedRemovals,
  type FullTripDraft,
  type TripSpineOption,
} from './index'

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
    endDate: '',
    start: '',
    end: '',
    from: '',
    to: '',
    confirm: '',
    cost: null,
    currency: 'EUR',
    status: 'planned',
    notes: partial.notes || '',
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

function trip(items: TripItem[]): TripRecord {
  return sanitizeTripRecord({
    id: 'T-rm',
    meta: {
      name: 'Test',
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

const spine: TripSpineOption = {
  id: 's1',
  label: 'Loop',
  summary: 's',
  areas: [
    { label: 'Nice', roughNights: 3, transportHint: 'walk_city' },
  ],
  openQuestions: [],
}

function baseDraft(over?: Partial<FullTripDraft>): FullTripDraft {
  return {
    summary: 's',
    spine,
    dayPlan: [
      {
        date: '2026-06-01',
        areaLabel: 'Nice',
        theme: 'Day',
        why: 'w',
        highlights: [],
      },
    ],
    planPlaceNames: [],
    items: [],
    openQuestions: [],
    ...over,
  }
}

describe('step removal consent', () => {
  it('detects yes/no', () => {
    expect(userAffirmedRemovals('yes')).toBe(true)
    expect(userAffirmedRemovals('remove them')).toBe(true)
    expect(userDeclinedRemovals('no keep them')).toBe(true)
    expect(userAffirmedRemovals('what about hotels?')).toBe(false)
  })

  it('strips unconfirmed removeItemIds into an ask', () => {
    const t = trip([
      item({ id: 'U1', title: 'My vineyard', date: '2026-06-01' }),
    ])
    const gated = gateDraftRemovals(
      t,
      baseDraft({ removeItemIds: ['U1'] }),
      'reshape the day',
      null,
    )
    expect(gated.draft.removeItemIds).toBeUndefined()
    expect(gated.draft.pendingRemovals?.[0]?.itemId).toBe('U1')
    expect(gated.ask).toMatch(/OK to remove/i)
    expect(gated.ask).toMatch(/My vineyard/)
  })

  it('promotes pendingRemovals after explicit yes', () => {
    const t = trip([
      item({ id: 'U1', title: 'My vineyard', date: '2026-06-01' }),
    ])
    const prev = baseDraft({
      pendingRemovals: [
        {
          itemId: 'U1',
          title: 'My vineyard',
          reason: 'Crowds the birthday evening',
        },
      ],
    })
    const gated = gateDraftRemovals(t, baseDraft(), 'yes, remove them', prev)
    expect(gated.draft.removeItemIds).toEqual(['U1'])
    expect(gated.draft.pendingRemovals).toBeUndefined()
  })

  it('applies confirmed removals and keeps unconfirmed steps', () => {
    const t = trip([
      item({ id: 'U1', title: 'My vineyard', date: '2026-06-01' }),
      item({ id: 'U2', title: 'Keep me', date: '2026-06-02' }),
    ])
    const withoutConsent = applyFullTripDraft(
      t,
      baseDraft({ removeItemIds: undefined }),
    )
    expect(withoutConsent.items.some((i) => i.id === 'U1')).toBe(true)

    const withConsent = applyFullTripDraft(
      t,
      baseDraft({ removeItemIds: ['U1'] }),
    )
    expect(withConsent.items.some((i) => i.id === 'U1')).toBe(false)
    expect(withConsent.items.some((i) => i.id === 'U2')).toBe(true)
  })
})
