/**
 * Persist Trip Planner enrich snapshots per trip (localStorage).
 * Latest first; capped to keep storage small.
 */

import type { Caveat } from '../agent/types'

export type EnrichFieldUpdate = {
  itemTitle: string
  field: string
  value: string
  confidence: 'high' | 'medium' | 'low'
  source: 'web' | 'model'
  citation?: string
}

export type EnrichSnapshot = {
  id: string
  /** epoch ms */
  at: number
  caveats: Caveat[]
  fieldUpdates: EnrichFieldUpdate[]
}

const MAX_PER_TRIP = 12
const PREFIX = 'trip-enrich-history:'

function storageKey(tripId: string): string {
  return `${PREFIX}${tripId}`
}

export function loadEnrichHistory(tripId: string): EnrichSnapshot[] {
  if (!tripId || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(tripId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is EnrichSnapshot => {
        if (!x || typeof x !== 'object') return false
        const o = x as Record<string, unknown>
        return typeof o.id === 'string' && typeof o.at === 'number'
      })
      .map((x) => ({
        id: String(x.id).slice(0, 64),
        at: Number(x.at),
        caveats: Array.isArray(x.caveats) ? (x.caveats as Caveat[]).slice(0, 40) : [],
        fieldUpdates: Array.isArray(x.fieldUpdates)
          ? (x.fieldUpdates as EnrichFieldUpdate[]).slice(0, 40)
          : [],
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PER_TRIP)
  } catch {
    return []
  }
}

export function saveEnrichHistory(
  tripId: string,
  history: EnrichSnapshot[],
): void {
  if (!tripId || typeof localStorage === 'undefined') return
  try {
    const trimmed = [...history]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PER_TRIP)
    localStorage.setItem(storageKey(tripId), JSON.stringify(trimmed))
  } catch {
    /* quota / private mode */
  }
}

export function pushEnrichSnapshot(
  tripId: string,
  snapshot: Omit<EnrichSnapshot, 'id' | 'at'> & { id?: string; at?: number },
): EnrichSnapshot[] {
  const entry: EnrichSnapshot = {
    id: snapshot.id || `enr-${Date.now().toString(36)}`,
    at: snapshot.at ?? Date.now(),
    caveats: snapshot.caveats,
    fieldUpdates: snapshot.fieldUpdates,
  }
  const next = [entry, ...loadEnrichHistory(tripId).filter((h) => h.id !== entry.id)]
  saveEnrichHistory(tripId, next)
  return next
}

export function formatEnrichWhen(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
}
