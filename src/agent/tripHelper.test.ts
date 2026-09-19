import { describe, expect, it } from 'vitest'
import type { TripItem, TripRecord } from '../domain/types'
import {
  clearChatSession,
  greetingForTrip,
  loadChatSession,
  mergeTripDrafts,
  restartConversationForTrip,
  saveChatSession,
  type FullTripDraft,
} from './index'

function flightItem(partial: Partial<TripItem> & { id: string }): TripItem {
  return {
    id: partial.id,
    type: 'flight',
    title: partial.title || 'Flight',
    place: partial.place || '',
    city: partial.city || '',
    date: partial.date || '2026-10-01',
    endDate: partial.endDate || '',
    start: partial.start || '08:00',
    end: partial.end || '12:00',
    from: partial.from || 'TLV',
    to: partial.to || 'NCE',
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

function tripWithFlight(): TripRecord {
  return {
    id: 'T-restart',
    meta: {
      name: 'South loop',
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: 'romantic',
      plannerPrefs: { adoptedAreas: ['Nice', 'Menton'] },
    },
    items: [flightItem({ id: 'F1', title: 'TLV→NCE' })],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  }
}

function baseDraft(): FullTripDraft {
  return {
    summary: 'Coast loop',
    spine: {
      id: 's1',
      label: 'Nice → Menton',
      summary: 'Coast',
      areas: [
        { label: 'Nice', roughNights: 3, transportHint: 'walk_city', theme: 'Base' },
        { label: 'Menton', roughNights: 2, transportHint: 'transit_ok', theme: 'Quiet' },
      ],
      openQuestions: [],
    },
    dayPlan: [
      {
        date: '2026-10-01',
        areaLabel: 'Nice',
        theme: 'Arrive',
        why: 'Landing day',
        highlights: [],
      },
      {
        date: '2026-10-02',
        areaLabel: 'Nice',
        theme: 'Old town',
        why: 'Explore',
        highlights: [{ name: 'Cours Saleya', why: 'Market' }],
      },
      {
        date: '2026-10-03',
        areaLabel: 'Nice',
        theme: 'Birthday',
        special: true,
        why: 'Celebration',
        highlights: [{ name: 'Spa', why: 'Treat' }],
      },
    ],
    planPlaceNames: [],
    items: [],
    openQuestions: [],
  }
}

describe('greetingForTrip / restart', () => {
  it('mentions existing flight and stay zones', () => {
    const g = greetingForTrip(tripWithFlight())
    expect(g.message).toMatch(/TLV→NCE|flight/i)
    expect(g.message).toMatch(/Nice/)
    expect(g.modeLabel).toBe('Listening')
  })

  it('restart clears chat session and marks fresh start', () => {
    const trip = tripWithFlight()
    saveChatSession(trip.id, {
      messages: [
        { id: 'M1', role: 'user', text: 'hallucinated nonsense' },
        { id: 'M2', role: 'assistant', text: 'wrong answer' },
      ],
      modeLabel: 'Ready to apply',
      reason: 'stale',
      checklist: {
        vibe: true,
        route: true,
        stayZones: true,
        details: true,
        ready: true,
      },
    })
    expect(loadChatSession(trip.id)?.messages.length).toBe(2)

    const g = restartConversationForTrip(trip)
    expect(loadChatSession(trip.id)).toBeNull()
    expect(g.message).toMatch(/Fresh start/i)
    expect(g.message).toMatch(/What do you need next/i)
    expect(g.checklist.ready).toBe(false)
    expect(g.modeLabel).toBe('Listening')

    clearChatSession(trip.id)
  })
})

describe('mergeTripDrafts surgical day patch', () => {
  it('overlays one day without wiping the rest', () => {
    const prev = baseDraft()
    const next: FullTripDraft = {
      ...prev,
      summary: 'Touched birthday only',
      dayPlan: [
        {
          date: '2026-10-03',
          areaLabel: 'Nice',
          theme: 'Birthday dinner',
          special: true,
          why: 'Romantic dinner',
          highlights: [{ name: 'Port', why: 'Evening views' }],
        },
      ],
      decisions: [{ what: 'Birthday evening', why: 'User asked for dinner focus' }],
    }
    const merged = mergeTripDrafts(prev, next)
    expect(merged.dayPlan).toHaveLength(3)
    expect(merged.dayPlan[0]?.theme).toBe('Arrive')
    expect(merged.dayPlan[1]?.theme).toBe('Old town')
    expect(merged.dayPlan[2]?.theme).toBe('Birthday dinner')
    expect(merged.dayPlan[2]?.highlights[0]?.name).toBe('Port')
    expect(merged.spine.areas).toHaveLength(2)
  })
})
