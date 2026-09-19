/**
 * Journey Day Helper facade — briefing + place provider + coach + Plan seeds.
 */

import type { TripRecord } from '../domain/types'
import {
  buildCoachRequestBody,
  gatherCoachCandidates,
  requestCoachAdvice,
} from '../data/aiCoach'
import type { AiCoachApiResponse, AiCoachOption, AiCoachPatch } from '../data/aiCoachTypes'
import type { ExplorePlace } from '../data/explore'
import {
  addPlanPlace,
  planMaybeSection,
  planSectionForExploreCategory,
} from '../data/planBoard'
import { nowIso } from '../data/db'
import {
  briefingToPlanningHints,
  compileTripDayBriefing,
  mergePlannerPrefs,
} from './context/compileDayBriefing'
import {
  markPlacesUnhealthy,
  resolvePlaceProvider,
  useGooglePlacesNow,
} from './placeProvider'
import type { PlannerPrefs } from './types'

export type DayHelperMode = 'plan' | 'summarize'

export async function runDayHelper(args: {
  trip: TripRecord
  day: string
  userMessage: string
  clarifications?: string[]
  mode?: DayHelperMode
  signal?: AbortSignal
}): Promise<{
  response: AiCoachApiResponse | { kind: 'summary'; text: string }
  candidates: ExplorePlace[]
  tripWithPrefs: TripRecord
  briefingHints: string[]
}> {
  const provider = await resolvePlaceProvider({ signal: args.signal })
  const useGoogle = provider === 'google'

  let candidates: ExplorePlace[] = []
  try {
    candidates = await gatherCoachCandidates(args.trip, args.day, {
      useGooglePlaces: useGoogle,
      signal: args.signal,
    })
  } catch (e) {
    markPlacesUnhealthy(e instanceof Error ? e.message : String(e))
    if (useGoogle) {
      candidates = await gatherCoachCandidates(args.trip, args.day, {
        useGooglePlaces: false,
        signal: args.signal,
      })
    } else {
      throw e
    }
  }

  const briefing = compileTripDayBriefing(args.trip, args.day)
  const extraHints = briefingToPlanningHints(briefing)
  const body = buildCoachRequestBody({
    trip: args.trip,
    day: args.day,
    userMessage:
      args.mode === 'summarize'
        ? `Summarize this day and suggest soft improvements (do not invent hotels). ${args.userMessage}`
        : args.userMessage,
    clarifications: args.clarifications || [],
    candidates,
  })
  body.planningHints = [...(body.planningHints || []), ...extraHints].slice(0, 20)

  if (args.mode === 'summarize') {
    // Prefer options from model; if clarification, return as summary prompt
    const response = await requestCoachAdvice(body, candidates, args.signal)
    if (response.kind === 'need_clarification') {
      return {
        response: { kind: 'summary', text: response.question },
        candidates,
        tripWithPrefs: args.trip,
        briefingHints: extraHints,
      }
    }
    const text = response.options
      .map((o) => `• ${o.label}: ${o.summary}`)
      .join('\n')
    return {
      response: {
        kind: 'summary',
        text:
          text ||
          'Day looks light — add a café, a sight, and a meal when you are ready.',
      },
      candidates,
      tripWithPrefs: args.trip,
      briefingHints: extraHints,
    }
  }

  const response = await requestCoachAdvice(body, candidates, args.signal)
  return {
    response,
    candidates,
    tripWithPrefs: args.trip,
    briefingHints: extraHints,
  }
}

/** Persist a clarification answer into plannerPrefs.notes / vibe. */
export function rememberClarification(
  trip: TripRecord,
  userReply: string,
): TripRecord {
  const note = userReply.trim().slice(0, 300)
  if (!note) return trip
  const patch: Partial<PlannerPrefs> = { notes: [note] }
  if (/car|drive|rental/i.test(note)) patch.transport = 'car'
  if (/train|transit|rail|no car/i.test(note)) patch.transport = 'transit'
  if (/soft|slow|relax|chill/i.test(note)) patch.pace = 'soft'
  if (/packed|busy|see everything/i.test(note)) patch.pace = 'packed'
  return mergePlannerPrefs(trip, patch)
}

/**
 * Apply addPlanPlaces from a coach option onto Discover lists (no Journey schedule).
 */
export function applyCoachPlanSeeds(
  trip: TripRecord,
  patch: AiCoachPatch,
  candidates: ExplorePlace[],
): TripRecord {
  const seeds = patch.addPlanPlaces || []
  if (!seeds.length) return trip
  let next = trip
  const byId = new Map(candidates.map((c) => [c.id, c]))
  for (const seed of seeds) {
    const place = byId.get(seed.candidateId)
    if (!place) continue
    if (place.category === 'hotel') continue // never seed hotels from Day Helper
    const sectionWant =
      seed.section === 'food'
        ? 'food'
        : seed.section === 'maybe'
          ? 'maybe'
          : 'must'
    const section =
      sectionWant === 'maybe'
        ? planMaybeSection(next)
        : planSectionForExploreCategory(
            next,
            sectionWant === 'food' ? 'food' : 'sights',
          ) || planMaybeSection(next)
    if (!section) continue
    next = addPlanPlace(next, {
      sectionId: section.id,
      name: place.name,
      place: place.address || place.name,
      city: '',
      notes: `Day Helper suggestion (${useGooglePlacesNow() ? 'Google' : 'OSM'})`,
      lat: place.lat,
      lon: place.lon,
      url: place.website || '',
      googleMapsUri: '',
      osmId: place.osmId || '',
      enrichmentSummary: place.summary || '',
      enrichmentImage: place.images[0] || '',
      images: place.images.slice(0, 6),
      openingHours: place.openingHours || '',
      openingPeriods: place.openingPeriods || [],
      rating: place.rating,
      cuisine: place.cuisine || '',
      googlePhotoName: '',
    })
  }
  return { ...next, updatedAt: nowIso() }
}

export function optionHasPlanSeeds(option: AiCoachOption): boolean {
  return Boolean(option.patch.addPlanPlaces?.length)
}

export function optionHasJourneyPatch(option: AiCoachOption): boolean {
  const p = option.patch
  return Boolean(
    p.addSteps?.length ||
      p.addDrives?.length ||
      p.setTimes?.length ||
      p.removeSteps?.length ||
      p.addNote,
  )
}
