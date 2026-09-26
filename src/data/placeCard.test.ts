import { describe, expect, it } from 'vitest'
import { mapLocationIqHit } from '../../api/geocode'
import {
  PLACE_DETAILS_FIELD_MASK,
  TEXT_ID_FIELD_MASK,
  placeDetailsMaskIsSafe,
} from '../../api/places-card'
import { mergeExplorePlaceCard, type PlaceCard } from './placeCard'
import type { ExplorePlace } from './explore'

function searchPlace(): ExplorePlace {
  return {
    id: 'way/1',
    name: 'Cafe Example',
    lat: 48.86,
    lon: 2.34,
    category: 'sights',
    osmType: 'search',
    osmId: 'way/1',
    wikidata: '',
    images: [],
    summary: '',
    distKm: 0,
    rating: null,
    cuisine: '',
    website: '',
    menuUrl: '',
    openingHours: '',
    address: '1 Rue Example, Paris',
    tags: { source: 'search', searchQuery: 'cafe example paris' },
  }
}

describe('LocationIQ hit mapping', () => {
  it('keeps coordinates, name, and OSM extras', () => {
    const place = mapLocationIqHit({
      lat: '48.853',
      lon: '2.349',
      display_name: 'Café de Flore, Paris, France',
      osm_type: 'node',
      osm_id: 42,
      address: { amenity: 'Café de Flore', city: 'Paris' },
      extratags: {
        website: 'http://cafedeflore.fr',
        opening_hours: 'Mo-Su 07:30-01:30',
      },
    })
    expect(place).toMatchObject({
      lat: 48.853,
      lon: 2.349,
      name: 'Café de Flore',
      city: 'Paris',
      osmId: 'node/42',
      website: 'https://cafedeflore.fr/',
      openingHours: 'Mo-Su 07:30-01:30',
    })
  })

  it('rejects a hit without coordinates', () => {
    expect(mapLocationIqHit({ display_name: 'Nowhere' })).toBeNull()
  })
})

describe('Place card billing mask', () => {
  it('uses the free id-only text search and skips Atmosphere fields', () => {
    expect(TEXT_ID_FIELD_MASK).toBe('places.id')
    expect(placeDetailsMaskIsSafe(PLACE_DETAILS_FIELD_MASK)).toBe(true)
    expect(PLACE_DETAILS_FIELD_MASK).not.toContain('editorialSummary')
    expect(PLACE_DETAILS_FIELD_MASK).not.toContain('generativeSummary')
    expect(PLACE_DETAILS_FIELD_MASK).toContain('rating')
    expect(PLACE_DETAILS_FIELD_MASK).toContain('regularOpeningHours')
  })
})

describe('mergeExplorePlaceCard', () => {
  it('fills rating, hours, and the maps link without moving the pin', () => {
    const card: PlaceCard = {
      placeId: 'ChIJ',
      name: 'Café de Flore',
      address: '172 Boulevard Saint-Germain, Paris',
      lat: 48.854,
      lon: 2.333,
      category: 'food',
      rating: 4.4,
      userRatingCount: 1200,
      website: 'https://cafedeflore.fr/',
      googleMapsUri: 'https://maps.google.com/?cid=1',
      openingHours: 'Monday: 7:30 AM – 1:30 AM',
      openingPeriods: [{ open: { day: 1, hour: 7, minute: 30 }, close: { day: 2, hour: 1, minute: 30 } }],
      photoName: 'places/ChIJ/photos/abc',
    }
    const merged = mergeExplorePlaceCard(searchPlace(), card)
    expect(merged.lat).toBe(48.86)
    expect(merged.lon).toBe(2.34)
    expect(merged.rating).toBe(4.4)
    expect(merged.category).toBe('food')
    expect(merged.website).toBe('https://cafedeflore.fr/')
    expect(merged.tags.googleMapsUri).toBe('https://maps.google.com/?cid=1')
    expect(merged.tags.cardFetched).toBe('1')
    expect(merged.images[0]).toContain('/api/places-photo')
  })
})
