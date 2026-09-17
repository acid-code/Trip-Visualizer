import { describe, expect, it } from 'vitest'
import { remapPlanPlaceLinks } from './db'
import { blankPlanPlaceEnrichment, type PlanPlace } from '../domain/types'

describe('remapPlanPlaceLinks', () => {
  it('remaps section and linked Journey item ids', () => {
    const places: PlanPlace[] = [
      {
        id: 'PP_OLD',
        sectionId: 'SEC_OLD',
        name: 'Louvre',
        place: 'Louvre',
        city: 'Paris',
        notes: '',
        lat: 48.86,
        lon: 2.34,
        url: '',
        googleMapsUri: '',
        osmId: '',
        scheduledDay: '2026-09-18',
        dayOrder: 1,
        linkedItemId: 'S_OLD',
        ...blankPlanPlaceEnrichment(),
      },
      {
        id: 'PP_ORPHAN',
        sectionId: 'SEC_OLD',
        name: 'Maybe',
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
    ]
    const sectionIdMap = new Map([['SEC_OLD', 'SEC_NEW']])
    const itemIdMap = new Map([['S_OLD', 'S_NEW']])
    let n = 0
    const next = remapPlanPlaceLinks(places, sectionIdMap, itemIdMap, () => `PP_${++n}`)
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({
      id: 'PP_1',
      sectionId: 'SEC_NEW',
      linkedItemId: 'S_NEW',
      scheduledDay: '2026-09-18',
      dayOrder: 1,
    })
    expect(next[1]).toMatchObject({
      id: 'PP_2',
      sectionId: 'SEC_NEW',
      linkedItemId: '',
    })
  })

  it('drops broken linkedItemId when item was not remapped', () => {
    const places: PlanPlace[] = [
      {
        id: 'PP1',
        sectionId: 'SEC1',
        name: 'X',
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
        linkedItemId: 'MISSING',
        ...blankPlanPlaceEnrichment(),
      },
    ]
    const next = remapPlanPlaceLinks(places, new Map(), new Map(), () => 'PP_NEW')
    expect(next[0]?.linkedItemId).toBe('')
  })
})
