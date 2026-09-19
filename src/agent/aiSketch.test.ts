import { describe, expect, it } from 'vitest'
import type { TripRecord } from '../domain/types'
import { sanitizeTripRecord } from '../domain/types'
import {
  AI_SKETCH_MAX_VERSIONS,
  aiSketchFromVersionStack,
  tripWithAiSketch,
  tripWithoutAiSketch,
  versionStackFromAiSketch,
} from './aiSketch'
import type { FullTripDraft } from './types'
import type { VersionStack } from './draftVersions'

function emptyTrip(): TripRecord {
  return sanitizeTripRecord({
    id: 'T-share',
    meta: {
      name: 'Shared',
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      homeCurrency: 'EUR',
      timezoneNote: '',
      travelers: '',
      notes: '',
      vibe: '',
      plannerPrefs: {},
    },
    items: [],
    planSections: [],
    planPlaces: [],
    isExample: false,
    createdAt: '',
    updatedAt: '',
  })
}

function draft(label: string): FullTripDraft {
  return {
    summary: label,
    spine: {
      id: 's1',
      label,
      summary: label,
      areas: [
        {
          label: 'Nice',
          roughNights: 2,
          transportHint: 'walk_city',
          theme: 'Base',
        },
      ],
      openQuestions: [],
    },
    dayPlan: [
      {
        date: '2026-10-01',
        areaLabel: 'Nice',
        theme: 'Arrive',
        why: 'Land',
        highlights: [],
      },
    ],
    planPlaceNames: [],
    items: [],
    openQuestions: [],
  }
}

describe('aiSketch share payload', () => {
  it('round-trips a version stack on TripRecord (no chat)', () => {
    const stack: VersionStack = {
      versions: [
        {
          id: 'TV1',
          at: 100,
          label: 'v1',
          reason: 'first',
          mode: 'Ready to apply',
          draft: draft('Coast'),
          byUid: 'u1',
          byLabel: 'Asaf',
          byEmail: 'asaf@example.com',
        },
      ],
      index: 0,
    }
    const trip = tripWithAiSketch(emptyTrip(), stack)
    expect(trip.aiSketch?.versions).toHaveLength(1)
    expect(trip.aiSketch?.versions[0]?.draft.spine.label).toBe('Coast')
    expect(trip.aiSketch?.versions[0]?.byLabel).toBe('Asaf')
    expect(trip.aiSketch?.versions[0]?.byUid).toBe('u1')
    const back = versionStackFromAiSketch(trip.aiSketch)
    expect(back.versions[0]?.label).toBe('v1')
    expect(back.versions[0]?.byLabel).toBe('Asaf')
    expect(back.index).toBe(0)
  })

  it('caps shared history and clears without leaving chat fields', () => {
    const versions = Array.from({ length: AI_SKETCH_MAX_VERSIONS + 3 }, (_, i) => ({
      id: `TV${i}`,
      at: i + 1,
      label: `v${i}`,
      reason: 'r',
      mode: 'Listening' as const,
      draft: draft(`D${i}`),
    }))
    const sketch = aiSketchFromVersionStack({
      versions,
      index: versions.length - 1,
    })
    expect(sketch?.versions).toHaveLength(AI_SKETCH_MAX_VERSIONS)
    expect(sketch?.versions[0]?.id).toBe('TV3')

    const cleared = tripWithoutAiSketch(
      tripWithAiSketch(emptyTrip(), { versions, index: versions.length - 1 }),
    )
    expect(cleared.aiSketch).toBeUndefined()
    expect(
      Object.prototype.hasOwnProperty.call(cleared, 'chatSession'),
    ).toBe(false)
  })
})
