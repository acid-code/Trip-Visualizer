import { describe, expect, it } from 'vitest'
import type { TripItem } from '../domain/types'
import { suggestInsertSlot } from './insertSlot'

function item(
  partial: Partial<TripItem> & Pick<TripItem, 'id' | 'date'>,
): TripItem {
  return {
    title: 'Step',
    place: '',
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
    type: 'sight',
    ...partial,
  }
}

describe('suggestInsertSlot', () => {
  it('uses next-day morning when inserting between days', () => {
    const after = item({
      id: 'A',
      date: '2026-09-17',
      start: '18:00',
      end: '19:00',
      title: 'Dinner',
    })
    const before = item({
      id: 'B',
      date: '2026-09-18',
      start: '10:00',
      title: 'Museum',
    })
    expect(suggestInsertSlot(after, before, '2026-09-17')).toEqual({
      date: '2026-09-18',
      start: '09:15',
    })
  })

  it('defaults to 09:00 on the next day when the arriving day has no useful start', () => {
    const after = item({ id: 'A', date: '2026-09-17', start: '10:00' })
    const before = item({
      id: 'B',
      date: '2026-09-18',
      start: '00:00',
      type: 'hotel',
      tags: ['day-base', 'placeholder'],
      title: 'Day 2 base',
    })
    expect(suggestInsertSlot(after, before, '2026-09-17')).toEqual({
      date: '2026-09-18',
      start: '09:00',
    })
  })

  it('keeps same-day midpoint between neighbors', () => {
    const after = item({
      id: 'A',
      date: '2026-09-17',
      start: '10:00',
      end: '11:00',
    })
    const before = item({
      id: 'B',
      date: '2026-09-17',
      start: '14:00',
    })
    expect(suggestInsertSlot(after, before, '2026-09-17')).toEqual({
      date: '2026-09-17',
      start: '12:30',
    })
  })
})
