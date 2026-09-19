/**
 * Diff Journey items before vs after a Whole Trip / AI merge.
 */

import type { TripItem } from '../domain/types'
import { sortItems } from '../data/db'

export type TripMergeDiff = {
  addedIds: string[]
  changedIds: string[]
  removedIds: string[]
}

/** Stable fingerprint of fields a merge can change. */
export function itemMergeFingerprint(item: TripItem): string {
  return [
    item.type,
    item.title,
    item.place,
    item.city,
    item.date,
    item.endDate || '',
    item.start || '',
    item.end || '',
    item.from || '',
    item.to || '',
    item.lat ?? '',
    item.lon ?? '',
    item.latTo ?? '',
    item.lonTo ?? '',
    item.geocodeQuery || '',
    item.status,
    (item.tags || []).slice().sort().join(','),
    (item.notes || '').slice(0, 120),
  ].join('\u001f')
}

export function diffTripItems(
  before: TripItem[],
  after: TripItem[],
): TripMergeDiff {
  const beforeById = new Map(before.map((i) => [i.id, i]))
  const afterById = new Map(after.map((i) => [i.id, i]))
  const addedIds: string[] = []
  const changedIds: string[] = []
  const removedIds: string[] = []

  for (const [id, item] of afterById) {
    const prev = beforeById.get(id)
    if (!prev) {
      addedIds.push(id)
      continue
    }
    if (itemMergeFingerprint(prev) !== itemMergeFingerprint(item)) {
      changedIds.push(id)
    }
  }
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) removedIds.push(id)
  }
  return { addedIds, changedIds, removedIds }
}

export function summarizeMergeDiff(diff: TripMergeDiff): string {
  const parts: string[] = []
  if (diff.addedIds.length) parts.push(`+${diff.addedIds.length}`)
  if (diff.changedIds.length) parts.push(`~${diff.changedIds.length}`)
  if (diff.removedIds.length) parts.push(`−${diff.removedIds.length}`)
  return parts.join(' · ') || 'no step changes'
}

const REMOVED_TAG = 'ai-review-removed'

export function isAiReviewRemoved(item: TripItem): boolean {
  return item.tags?.includes(REMOVED_TAG) === true
}

/**
 * Draft steps plus grey ghost rows for removals, sorted for the Steps list.
 */
export function mergeReviewDisplayItems(
  draftItems: TripItem[],
  beforeItems: TripItem[],
  removedIds: string[],
): TripItem[] {
  if (!removedIds.length) return draftItems
  const removed = new Set(removedIds)
  const ghosts = beforeItems
    .filter((i) => removed.has(i.id))
    .map((i) => ({
      ...i,
      tags: [...new Set([...(i.tags || []), REMOVED_TAG])],
    }))
  return sortItems([...draftItems, ...ghosts])
}
