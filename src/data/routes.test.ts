import { describe, expect, it } from 'vitest'
import type { TripItem } from '../domain/types'
import {
  driveRouteMatchesEndpoints,
  withInvalidatedDriveRoutes,
} from './routes'

function drive(partial: Partial<TripItem> & Pick<TripItem, 'id'>): TripItem {
  return {
    title: 'Drive',
    place: '',
    city: '',
    endDate: '',
    start: '10:00',
    end: '',
    from: 'A',
    to: 'B',
    confirm: '',
    cost: null,
    currency: 'EUR',
    status: 'planned',
    notes: '',
    url: '',
    tags: [],
    lat: 48.86,
    lon: 2.34,
    latTo: 48.87,
    lonTo: 2.35,
    wikidata: '',
    osmId: '',
    rating: null,
    googleMapsUri: '',
    geocodeQuery: '',
    updatedAt: '2026-09-17T10:00:00.000Z',
    enrichmentSummary: '',
    enrichmentImage: '',
    enrichmentSource: '',
    routeCoords: [],
    source: 'app',
    date: '2026-09-17',
    ...partial,
    type: 'drive',
  }
}

describe('driveRouteMatchesEndpoints / withInvalidatedDriveRoutes', () => {
  it('matches when polyline ends near current From/To', () => {
    const item = drive({
      id: 'D1',
      lat: 48.86,
      lon: 2.34,
      latTo: 48.87,
      lonTo: 2.35,
      routeCoords: [
        [48.86, 2.34],
        [48.865, 2.345],
        [48.87, 2.35],
      ],
    })
    expect(driveRouteMatchesEndpoints(item)).toBe(true)
    expect(withInvalidatedDriveRoutes([item])[0]?.routeCoords?.length).toBe(3)
  })

  it('rejects polyline when endpoints moved far away', () => {
    const item = drive({
      id: 'D2',
      lat: 45.0,
      lon: 5.0,
      latTo: 46.0,
      lonTo: 6.0,
      routeCoords: [
        [48.86, 2.34],
        [48.87, 2.35],
      ],
    })
    expect(driveRouteMatchesEndpoints(item)).toBe(false)
    const next = withInvalidatedDriveRoutes([item])[0]!
    expect(next.routeCoords).toEqual([])
  })

  it('treats missing/short polylines as non-matching (needs hydrate)', () => {
    expect(
      driveRouteMatchesEndpoints(drive({ id: 'D3', routeCoords: [[48.86, 2.34]] })),
    ).toBe(false)
    expect(driveRouteMatchesEndpoints(drive({ id: 'D4', routeCoords: [] }))).toBe(
      false,
    )
  })

  it('leaves non-drive items untouched', () => {
    const sight: TripItem = {
      ...drive({ id: 'S1' }),
      type: 'sight',
      routeCoords: [
        [1, 2],
        [3, 4],
      ],
    }
    expect(driveRouteMatchesEndpoints(sight)).toBe(true)
    expect(withInvalidatedDriveRoutes([sight])[0]?.routeCoords).toEqual([
      [1, 2],
      [3, 4],
    ])
  })
})
