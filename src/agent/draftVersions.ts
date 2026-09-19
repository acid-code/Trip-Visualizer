/**
 * Session-scoped Whole Trip draft version stack (back/forward → Apply).
 */

import { createId } from '../data/db'
import type { FullTripDraft, TripChatModeLabel, TripDraftVersion } from './types'

const PREFIX = 'trip-draft-versions:'
const MAX = 12

export type VersionStack = {
  versions: TripDraftVersion[]
  /** Index into versions currently previewed */
  index: number
}

function key(tripId: string): string {
  return `${PREFIX}${tripId}`
}

export function loadVersionStack(tripId: string): VersionStack {
  if (!tripId || typeof sessionStorage === 'undefined') {
    return { versions: [], index: -1 }
  }
  try {
    const raw = sessionStorage.getItem(key(tripId))
    if (!raw) return { versions: [], index: -1 }
    const parsed = JSON.parse(raw) as VersionStack
    if (!Array.isArray(parsed.versions)) return { versions: [], index: -1 }
    return {
      versions: parsed.versions.slice(0, MAX),
      index: Math.min(
        Math.max(-1, Number(parsed.index)),
        parsed.versions.length - 1,
      ),
    }
  } catch {
    return { versions: [], index: -1 }
  }
}

export function saveVersionStack(tripId: string, stack: VersionStack): void {
  if (!tripId || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(
      key(tripId),
      JSON.stringify({
        versions: stack.versions.slice(0, MAX),
        index: stack.index,
      }),
    )
  } catch {
    /* quota */
  }
}

/**
 * Push a new version. If index is not at the tip, truncate forward history (fork).
 */
export function pushDraftVersion(
  tripId: string,
  stack: VersionStack,
  entry: {
    label: string
    reason: string
    mode: TripChatModeLabel
    draft: FullTripDraft
  },
): VersionStack {
  const base =
    stack.index >= 0 ? stack.versions.slice(0, stack.index + 1) : []
  const version: TripDraftVersion = {
    id: createId('TV'),
    at: Date.now(),
    label: entry.label.slice(0, 80),
    reason: entry.reason.slice(0, 240),
    mode: entry.mode,
    draft: entry.draft,
  }
  const versions = [...base, version].slice(-MAX)
  const next = { versions, index: versions.length - 1 }
  saveVersionStack(tripId, next)
  return next
}

export function scrubVersion(
  tripId: string,
  stack: VersionStack,
  index: number,
): VersionStack {
  if (!stack.versions.length) return stack
  const i = Math.max(0, Math.min(stack.versions.length - 1, index))
  const next = { ...stack, index: i }
  saveVersionStack(tripId, next)
  return next
}

export function currentVersion(
  stack: VersionStack,
): TripDraftVersion | null {
  if (stack.index < 0 || !stack.versions[stack.index]) return null
  return stack.versions[stack.index]!
}

/** Drop draft versions for a trip (e.g. clear & restart conversation). */
export function clearVersionStack(tripId: string): void {
  if (!tripId || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(key(tripId))
  } catch {
    /* ignore */
  }
}
