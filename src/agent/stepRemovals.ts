/**
 * Gate Journey step deletions: ask first, apply only after an explicit yes.
 */

import type { TripRecord } from '../domain/types'
import type { FullTripDraft } from './types'

export type PendingStepRemoval = {
  itemId: string
  title: string
  reason: string
}

export function userAffirmedRemovals(userMessage: string): boolean {
  const m = userMessage.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!m) return false
  return (
    /^(yes|yep|yeah|ok|okay|sure|fine|go ahead|do it|please|sounds good|remove them|delete them|drop them)\b/.test(
      m,
    ) ||
    /\b(yes|ok|okay|sure),?\s+(remove|delete|drop)\b/.test(m) ||
    /\b(remove|delete|drop)\s+(them|those|it|all|that)\b/.test(m)
  )
}

export function userDeclinedRemovals(userMessage: string): boolean {
  const m = userMessage.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!m) return false
  return (
    /^(no|nope|nah|keep|don'?t|do not)\b/.test(m) ||
    /\b(keep|don'?t remove|do not remove|leave them)\b/.test(m)
  )
}

function formatRemovalAsk(pending: PendingStepRemoval[]): string {
  const lines = pending.map((p, i) => {
    const why = p.reason.trim() ? ` — ${p.reason.trim()}` : ''
    return `${i + 1}. ${p.title || p.itemId}${why}`
  })
  return [
    'Before I change anything, I need your OK to remove these Journey steps:',
    '',
    ...lines,
    '',
    'Reply yes to remove them on the next apply, or no to keep them.',
  ].join('\n')
}

function pendingFromIds(
  trip: TripRecord,
  ids: string[],
  reason: string,
): PendingStepRemoval[] {
  const out: PendingStepRemoval[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const it = trip.items.find((i) => i.id === id)
    if (!it) continue
    out.push({
      itemId: it.id,
      title: it.title || it.place || it.id,
      reason,
    })
    if (out.length >= 20) break
  }
  return out
}

/**
 * Never silently delete user steps. Unconfirmed removeItemIds become an ask;
 * an explicit yes promotes pendingRemovals into removeItemIds for apply.
 */
export function gateDraftRemovals(
  trip: TripRecord,
  draft: FullTripDraft,
  userMessage: string,
  prevDraft: FullTripDraft | null,
): { draft: FullTripDraft; ask?: string; keptMessage?: string } {
  const prevPending = prevDraft?.pendingRemovals || []
  const incomingPending = draft.pendingRemovals || []
  const awaiting = incomingPending.length ? incomingPending : prevPending

  if (awaiting.length && userAffirmedRemovals(userMessage)) {
    const ids = [
      ...new Set([
        ...(draft.removeItemIds || []),
        ...awaiting.map((p) => p.itemId),
      ]),
    ].slice(0, 40)
    return {
      draft: {
        ...draft,
        removeItemIds: ids,
        pendingRemovals: undefined,
        decisions: [
          ...(draft.decisions || []),
          {
            what: 'Remove confirmed Journey steps',
            why: 'You explicitly OK’d dropping them before apply.',
          },
        ].slice(0, 16),
      },
    }
  }

  if (awaiting.length && userDeclinedRemovals(userMessage)) {
    const blocked = new Set(awaiting.map((p) => p.itemId))
    return {
      draft: {
        ...draft,
        pendingRemovals: undefined,
        removeItemIds: (draft.removeItemIds || []).filter((id) => !blocked.has(id)),
      },
      keptMessage: 'Got it — I’ll keep those steps on the Journey.',
    }
  }

  const rawRemove = draft.removeItemIds || []
  if (rawRemove.length && !userAffirmedRemovals(userMessage)) {
    const pending = pendingFromIds(
      trip,
      rawRemove,
      'Suggested removal to simplify the route/day',
    )
    if (!pending.length) {
      return { draft: { ...draft, removeItemIds: undefined } }
    }
    return {
      draft: {
        ...draft,
        removeItemIds: undefined,
        pendingRemovals: pending,
      },
      ask: formatRemovalAsk(pending),
    }
  }

  if (incomingPending.length && !userAffirmedRemovals(userMessage)) {
    return {
      draft: {
        ...draft,
        removeItemIds: undefined,
        pendingRemovals: incomingPending.slice(0, 20),
      },
      ask: formatRemovalAsk(incomingPending.slice(0, 20)),
    }
  }

  return { draft }
}
