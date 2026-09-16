import { describe, expect, it } from 'vitest'
import { createId, nowIso } from './db'
import { sanitizeTripRecord } from '../domain/types'
import { tripRecordForCloud } from './cloudSync'
import { forFirestore } from './shareErrors'

describe('tripRecordForCloud', () => {
  it('round-trips Plan sections and places with Journey items', () => {
    const stamp = nowIso()
    const trip = sanitizeTripRecord({
      id: createId('TRIP'),
      meta: {
        name: 'Couple trip',
        startDate: '2026-09-17',
        endDate: '2026-09-17',
        homeCurrency: 'EUR',
        timezoneNote: 'All times are local',
        travelers: '2',
        notes: 'private-ish',
      },
      items: [
        {
          id: createId('S'),
          type: 'sight',
          title: 'Museum',
          place: 'Louvre',
          city: 'Paris',
          date: '2026-09-17',
          endDate: '',
          start: '10:00',
          end: '',
          from: '',
          to: '',
          notes: '',
          confirm: 'SECRET123',
          cost: null,
          currency: 'EUR',
          lat: 48.86,
          lon: 2.34,
          latTo: null,
          lonTo: null,
          url: '',
          googleMapsUri: '',
          osmId: '',
          tags: [],
          status: 'planned',
          source: 'app',
          updatedAt: stamp,
          routeCoords: [
            [48.86, 2.34],
            [48.87, 2.35],
          ],
        },
      ],
      planSections: [
        {
          id: createId('SEC'),
          title: 'Must see',
          color: '#f97316',
          icon: '📍',
          order: 0,
        },
      ],
      planPlaces: [
        {
          id: createId('PP'),
          sectionId: 'SEC1',
          name: 'Louvre',
          place: 'Louvre',
          city: 'Paris',
          notes: 'Go early',
          lat: 48.86,
          lon: 2.34,
          url: '',
          googleMapsUri: '',
          osmId: '',
          scheduledDay: '2026-09-17',
          dayOrder: 0,
          linkedItemId: '',
        },
      ],
      isExample: false,
      createdAt: stamp,
      updatedAt: stamp,
    })

    const sectionId = trip.planSections[0]!.id
    const withLink = sanitizeTripRecord({
      ...trip,
      planPlaces: trip.planPlaces.map((p) => ({ ...p, sectionId })),
    })

    const cloud = tripRecordForCloud({
      ...withLink,
      shareEnabled: true,
      cloudTripId: withLink.id,
      revision: 2,
    })
    const again = sanitizeTripRecord(JSON.parse(JSON.stringify(cloud)))

    expect(again.planSections).toHaveLength(1)
    expect(again.planPlaces).toHaveLength(1)
    expect(again.planPlaces[0]?.name).toBe('Louvre')
    expect(again.planPlaces[0]?.dayOrder).toBe(0)
    expect(again.items[0]?.title).toBe('Museum')
    expect(again.items[0]?.routeCoords?.length).toBe(2)
    expect(again.shareEnabled).toBe(true)
    expect(again.cloudTripId).toBe(withLink.id)
  })
})

describe('firestore routeCoords encoding', () => {
  it('keeps object coords Firestore-safe (no nested arrays)', () => {
    const encoded = forFirestore({
      routeCoords: [
        { lat: 1, lon: 2 },
        { lat: 3, lon: 4 },
      ],
    })
    expect(encoded).toEqual({
      routeCoords: [
        { lat: 1, lon: 2 },
        { lat: 3, lon: 4 },
      ],
    })
    expect(JSON.stringify({ routeCoords: [[1, 2]] }).includes('[[')).toBe(true)
  })
})
