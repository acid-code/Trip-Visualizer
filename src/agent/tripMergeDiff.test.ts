import { describe, expect, it } from 'vitest'
import type { TripItem } from '../domain/types'
import {
  diffTripItems,
  isAiReviewRemoved,
  mergeReviewDisplayItems,
  summarizeMergeDiff,
} from './tripMergeDiff'

function item(partial: Partial<TripItem> & { id: string; title: string }): TripItem {
  return {
    id: partial.id,
    type: partial.type || 'sight',
    title: partial.title,
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
    notes: partial.notes || '',
    url: '',
    tags: partial.tags || [],
    lat: partial.lat ?? null,
    lon: partial.lon ?? null,
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

describe('diffTripItems', () => {
  it('classifies added, changed, and removed', () => {
    const before = [
      item({ id: 'A', title: 'Keep' }),
      item({ id: 'B', title: 'Old name' }),
      item({ id: 'C', title: 'Gone' }),
    ]
    const after = [
      item({ id: 'A', title: 'Keep' }),
      item({ id: 'B', title: 'New name' }),
      item({ id: 'D', title: 'Fresh' }),
    ]
    const d = diffTripItems(before, after)
    expect(d.addedIds).toEqual(['D'])
    expect(d.changedIds).toEqual(['B'])
    expect(d.removedIds).toEqual(['C'])
    expect(summarizeMergeDiff(d)).toBe('+1 · ~1 · −1')
  })
})

describe('mergeReviewDisplayItems', () => {
  it('appends ghost removed rows', () => {
    const before = [item({ id: 'C', title: 'Gone', date: '2026-06-02' })]
    const draft = [item({ id: 'A', title: 'Keep', date: '2026-06-01' })]
    const merged = mergeReviewDisplayItems(draft, before, ['C'])
    expect(merged).toHaveLength(2)
    expect(isAiReviewRemoved(merged.find((i) => i.id === 'C')!)).toBe(true)
  })
})
