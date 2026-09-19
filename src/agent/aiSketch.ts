/**
 * Whole Trip AI sketches on TripRecord — sync with share.
 * Chat transcripts stay in sessionStorage (device-local only).
 */

import type { AiSketch, TripRecord } from '../domain/types'
import { AiSketchSchema, sanitizeTripRecord } from '../domain/types'
import type { FullTripDraft, TripChatModeLabel, TripDraftVersion } from './types'
import {
  loadVersionStack,
  saveVersionStack,
  type VersionStack,
} from './draftVersions'

/** Cap shared history so Firestore payloads stay lean. */
export const AI_SKETCH_MAX_VERSIONS = 6

const EMPTY_STACK: VersionStack = { versions: [], index: -1 }

const MODES: TripChatModeLabel[] = [
  'Listening',
  'Sketching a route',
  'Comparing stay zones',
  'Filling flight details',
  'Gathering must-knows',
  'Reshaping the trip',
  'Ready to apply',
]

function asMode(raw: string): TripChatModeLabel {
  return (MODES.includes(raw as TripChatModeLabel)
    ? raw
    : 'Listening') as TripChatModeLabel
}

export function stackFingerprint(stack: VersionStack): string {
  if (!stack.versions.length) return 'empty'
  const tip = stack.versions[Math.max(0, stack.index)]
  return `${stack.versions.length}|${stack.index}|${tip?.id || ''}|${tip?.at || 0}|${tip?.byUid || ''}`
}

export function versionStackFromAiSketch(
  sketch: AiSketch | null | undefined,
): VersionStack {
  if (!sketch?.versions?.length) return { ...EMPTY_STACK }
  const parsed = AiSketchSchema.safeParse(sketch)
  if (!parsed.success || !parsed.data.versions.length) {
    return { ...EMPTY_STACK }
  }
  const versions: TripDraftVersion[] = parsed.data.versions.map((v) => ({
    id: v.id,
    at: v.at,
    label: v.label,
    reason: v.reason,
    mode: asMode(v.mode),
    draft: v.draft as FullTripDraft,
    ...(v.byUid ? { byUid: v.byUid } : {}),
    ...(v.byLabel ? { byLabel: v.byLabel } : {}),
    ...(v.byEmail ? { byEmail: v.byEmail } : {}),
  }))
  return {
    versions,
    index: Math.min(
      Math.max(-1, parsed.data.index),
      versions.length - 1,
    ),
  }
}

export function aiSketchFromVersionStack(stack: VersionStack): AiSketch | undefined {
  if (!stack.versions.length) return undefined
  const slicedOff = Math.max(0, stack.versions.length - AI_SKETCH_MAX_VERSIONS)
  const versions = stack.versions.slice(-AI_SKETCH_MAX_VERSIONS)
  const index =
    stack.index < 0
      ? -1
      : Math.min(
          Math.max(-1, stack.index - slicedOff),
          versions.length - 1,
        )
  const raw = {
    versions: versions.map((v) => ({
      id: v.id,
      at: v.at,
      label: v.label,
      reason: v.reason,
      mode: v.mode,
      draft: v.draft,
      ...(v.byUid ? { byUid: v.byUid } : {}),
      ...(v.byLabel ? { byLabel: v.byLabel } : {}),
      ...(v.byEmail ? { byEmail: v.byEmail } : {}),
    })),
    index,
    updatedAt: Date.now(),
  }
  const parsed = AiSketchSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** Attach (or refresh) the shared sketch tip on the trip. */
export function tripWithAiSketch(
  trip: TripRecord,
  stack: VersionStack,
): TripRecord {
  const aiSketch = aiSketchFromVersionStack(stack)
  return sanitizeTripRecord({
    ...trip,
    aiSketch,
  })
}

/** Drop shared sketches (Restart chat) — chat clear is separate / local. */
export function tripWithoutAiSketch(trip: TripRecord): TripRecord {
  const { aiSketch: _drop, ...rest } = trip
  return sanitizeTripRecord({ ...rest, aiSketch: undefined })
}

/**
 * Prefer shared trip.aiSketch when present; else local session stack.
 * Mirrors shared tip into sessionStorage for fast scrub.
 */
export function loadSketchStack(trip: TripRecord): VersionStack {
  const fromTrip = versionStackFromAiSketch(trip.aiSketch)
  if (fromTrip.versions.length) {
    saveVersionStack(trip.id, fromTrip)
    return fromTrip
  }
  return loadVersionStack(trip.id)
}

export function mergeSketchSources(
  trip: TripRecord,
  sessionStack: VersionStack,
): VersionStack {
  const fromTrip = versionStackFromAiSketch(trip.aiSketch)
  if (!fromTrip.versions.length) return sessionStack
  if (!sessionStack.versions.length) return fromTrip
  const tripAt = trip.aiSketch?.updatedAt ?? 0
  const sessionTip = sessionStack.versions[sessionStack.index]
  const sessionAt = sessionTip?.at ?? 0
  // Shared tip wins when newer or equal (partner / other device).
  if (tripAt >= sessionAt) return fromTrip
  return sessionStack
}
