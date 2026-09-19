/**
 * Session-scoped Whole Trip chat transcript (user + assistant).
 * Draft versions alone felt cut off — answers must survive reopen.
 */

import type { TripChatModeLabel, TripChecklist } from './types'

const PREFIX = 'trip-chat-session:'
const MAX_MESSAGES = 48

/** In-memory fallback when sessionStorage is unavailable (tests / private mode). */
const memory = new Map<string, string>()

function storageGet(k: string): string | null {
  if (typeof sessionStorage !== 'undefined') {
    try {
      return sessionStorage.getItem(k)
    } catch {
      /* fall through */
    }
  }
  return memory.get(k) ?? null
}

function storageSet(k: string, v: string): void {
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(k, v)
      return
    } catch {
      /* fall through */
    }
  }
  memory.set(k, v)
}

function storageRemove(k: string): void {
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  memory.delete(k)
}

export type StoredChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type TripChatSession = {
  messages: StoredChatMessage[]
  modeLabel: TripChatModeLabel
  reason: string
  checklist: TripChecklist
  updatedAt: number
}

function emptyChecklist(): TripChecklist {
  return {
    vibe: false,
    route: false,
    stayZones: false,
    details: false,
    ready: false,
  }
}

function key(tripId: string): string {
  return `${PREFIX}${tripId}`
}

export function loadChatSession(tripId: string): TripChatSession | null {
  if (!tripId) return null
  try {
    const raw = storageGet(key(tripId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as TripChatSession
    if (!Array.isArray(parsed.messages) || !parsed.messages.length) return null
    const messages = parsed.messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string' &&
          m.text.trim() &&
          typeof m.id === 'string',
      )
      .slice(-MAX_MESSAGES)
      .map((m) => ({
        id: m.id.slice(0, 64),
        role: m.role,
        text: m.text.slice(0, 4000),
      }))
    if (!messages.length) return null
    const cl = parsed.checklist
    return {
      messages,
      modeLabel: (parsed.modeLabel as TripChatModeLabel) || 'Listening',
      reason: String(parsed.reason || '').slice(0, 400),
      checklist: {
        ...emptyChecklist(),
        ...(cl && typeof cl === 'object'
          ? {
              vibe: Boolean(cl.vibe),
              route: Boolean(cl.route),
              stayZones: Boolean(cl.stayZones),
              details: Boolean(cl.details),
              ready: Boolean(cl.ready),
            }
          : {}),
      },
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    }
  } catch {
    return null
  }
}

export function saveChatSession(
  tripId: string,
  session: Omit<TripChatSession, 'updatedAt'> & { updatedAt?: number },
): void {
  if (!tripId) return
  if (!session.messages.length) return
  try {
    const payload: TripChatSession = {
      messages: session.messages.slice(-MAX_MESSAGES).map((m) => ({
        id: m.id.slice(0, 64),
        role: m.role,
        text: m.text.slice(0, 4000),
      })),
      modeLabel: session.modeLabel,
      reason: session.reason.slice(0, 400),
      checklist: session.checklist,
      updatedAt: session.updatedAt ?? Date.now(),
    }
    storageSet(key(tripId), JSON.stringify(payload))
  } catch {
    /* quota */
  }
}

export function clearChatSession(tripId: string): void {
  if (!tripId) return
  storageRemove(key(tripId))
}
