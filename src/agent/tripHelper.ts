/**
 * Whole Trip chat orchestrator — picks tools from conversation (no feature tabs).
 */

import type { TripRecord } from '../domain/types'
import { prefsFromMeta } from './context/compileDayBriefing'
import { clearChatSession } from './chatSession'
import { clearVersionStack } from './draftVersions'
import {
  adaptSegmentToArea,
  allocateSpineToDays,
  composeFullTrip,
  existingStepsBrief,
  requestAreaKnowHow,
  requestAreaTips,
  requestEnrichment,
  requestSpineOptions,
  reshapeTrip,
} from './tripPlanner'
import type {
  AreaKnowHow,
  AreaTip,
  FullTripDraft,
  TripChatModeLabel,
  TripChatToolName,
  TripChatTurnResult,
  TripChecklist,
  TripSpineOption,
} from './types'

export type TripHelperMessage = {
  role: 'user' | 'assistant'
  text: string
}

export type TripHelperCard =
  | { type: 'spine'; options: TripSpineOption[] }
  | { type: 'tips'; tips: AreaTip[] }
  | {
      type: 'enrich'
      caveats: Array<{ topic: string; summary: string }>
    }
  | { type: 'knowhow'; areas: AreaKnowHow[]; summary: string }

export type TripHelperResult = {
  message: string
  modeLabel: TripChatModeLabel
  reason: string
  draft: FullTripDraft | null
  draftChanged: boolean
  cards: TripHelperCard[]
  checklist: TripChecklist
  stayZoneTrip?: TripRecord
  stayZoneMessage?: string
}

const DEFAULT_CHECKLIST: TripChecklist = {
  vibe: false,
  route: false,
  stayZones: false,
  details: false,
  ready: false,
}

async function postTripChat(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TripChatTurnResult> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'trip_chat', ...payload }),
    signal,
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(String(data.error || `Agent failed (${res.status})`))
  }
  return normalizeChatTurn(data)
}

function asMode(raw: unknown): TripChatModeLabel {
  const s = String(raw || 'Listening')
  const allowed: TripChatModeLabel[] = [
    'Listening',
    'Sketching a route',
    'Comparing stay zones',
    'Filling flight details',
    'Gathering must-knows',
    'Reshaping the trip',
    'Ready to apply',
  ]
  return (allowed.includes(s as TripChatModeLabel)
    ? s
    : 'Listening') as TripChatModeLabel
}

function normalizeChatTurn(data: Record<string, unknown>): TripChatTurnResult {
  const kind = String(data.kind || 'reply')
  const modeLabel = asMode(data.modeLabel)
  const reason = String(data.reason || '').slice(0, 240)
  if (kind === 'tool') {
    return {
      kind: 'tool',
      tool: String(data.tool || 'compose_full_trip') as TripChatToolName,
      args:
        data.args && typeof data.args === 'object'
          ? (data.args as Record<string, unknown>)
          : {},
      modeLabel,
      reason,
      message: data.message ? String(data.message).slice(0, 800) : undefined,
    }
  }
  if (kind === 'draft' && data.draft && typeof data.draft === 'object') {
    return {
      kind: 'draft',
      message: String(data.message || 'Updated the trip sketch.').slice(0, 1200),
      modeLabel: modeLabel === 'Listening' ? 'Ready to apply' : modeLabel,
      reason,
      draft: data.draft as FullTripDraft,
      checklist: data.checklist as Partial<TripChecklist> | undefined,
    }
  }
  return {
    kind: 'reply',
    message: String(
      data.message || data.question || 'Tell me more about the trip you want.',
    ).slice(0, 1200),
    modeLabel,
    reason,
    checklist: data.checklist as Partial<TripChecklist> | undefined,
  }
}

function mergeChecklist(
  prev: TripChecklist,
  patch?: Partial<TripChecklist>,
): TripChecklist {
  return { ...prev, ...(patch || {}) }
}

function spineToDraft(
  trip: TripRecord,
  spine: TripSpineOption,
  summary?: string,
): FullTripDraft {
  return {
    summary: summary || spine.summary,
    spine,
    dayPlan: allocateSpineToDays(
      trip.meta.startDate,
      trip.meta.endDate,
      spine.areas,
    ),
    planPlaceNames: [],
    items: [],
    openQuestions: spine.openQuestions,
  }
}

function mergeDraft(
  prev: FullTripDraft | null,
  next: FullTripDraft,
): FullTripDraft {
  if (!prev) return next
  return {
    ...prev,
    ...next,
    itemUpdates: [
      ...(prev.itemUpdates || []),
      ...(next.itemUpdates || []),
    ].slice(-40),
    droppedHighlights: next.droppedHighlights ?? prev.droppedHighlights,
  }
}

/**
 * One user turn: ask trip_chat what to do, run at most one tool, return UI payload.
 */
export async function runTripHelper(args: {
  trip: TripRecord
  userMessage: string
  transcript: TripHelperMessage[]
  draft: FullTripDraft | null
  checklist: TripChecklist
  signal?: AbortSignal
}): Promise<TripHelperResult> {
  const checklist = args.checklist || DEFAULT_CHECKLIST
  let turn: TripChatTurnResult
  try {
    turn = await postTripChat(
      {
        tripName: args.trip.meta.name,
        vibe: args.trip.meta.vibe,
        dates: {
          start: args.trip.meta.startDate,
          end: args.trip.meta.endDate,
        },
        prefs: prefsFromMeta(args.trip),
        existingSteps: existingStepsBrief(args.trip),
        currentDraft: args.draft
          ? {
              summary: args.draft.summary,
              spineLabel: args.draft.spine.label,
              areas: args.draft.spine.areas.map((a) => a.label),
              dayCount: args.draft.dayPlan.length,
              openQuestions: args.draft.openQuestions,
            }
          : null,
        checklist,
        transcript: args.transcript.slice(-12).map((m) => ({
          role: m.role,
          text: m.text.slice(0, 500),
        })),
        userMessage: args.userMessage.slice(0, 2500),
      },
      args.signal,
    )
  } catch (e) {
    return {
      message:
        e instanceof Error
          ? e.message
          : 'Could not reach the trip coach — try again.',
      modeLabel: 'Listening',
      reason: 'The coach could not answer that turn.',
      draft: args.draft,
      draftChanged: false,
      cards: [],
      checklist,
    }
  }

  if (turn.kind === 'reply') {
    return {
      message: turn.message,
      modeLabel: turn.modeLabel,
      reason: turn.reason || 'Waiting for a bit more detail.',
      draft: args.draft,
      draftChanged: false,
      cards: [],
      checklist: mergeChecklist(checklist, turn.checklist),
    }
  }

  if (turn.kind === 'draft') {
    const incoming = turn.draft
    const spine = incoming.spine?.areas?.length
      ? incoming.spine
      : args.draft?.spine
    if (!spine?.areas?.length) {
      return {
        message: turn.message,
        modeLabel: turn.modeLabel,
        reason: turn.reason,
        draft: args.draft,
        draftChanged: false,
        cards: [],
        checklist: mergeChecklist(checklist, turn.checklist),
      }
    }
    const draft = mergeDraft(args.draft, {
      summary: incoming.summary || args.draft?.summary || 'Trip sketch',
      titleSuggestion: incoming.titleSuggestion,
      spine,
      dayPlan:
        incoming.dayPlan?.length
          ? incoming.dayPlan
          : allocateSpineToDays(
              args.trip.meta.startDate,
              args.trip.meta.endDate,
              spine.areas,
            ),
      planPlaceNames: incoming.planPlaceNames || [],
      items: incoming.items || [],
      itemUpdates: incoming.itemUpdates,
      prefs: incoming.prefs,
      openQuestions: incoming.openQuestions || [],
      droppedHighlights: incoming.droppedHighlights,
    })
    return {
      message: turn.message,
      modeLabel: turn.modeLabel,
      reason: turn.reason,
      draft,
      draftChanged: true,
      cards: [],
      checklist: mergeChecklist(checklist, {
        ...turn.checklist,
        ready: true,
        route: true,
        vibe: true,
      }),
    }
  }

  // tool turn
  const toolMsg = turn.message
  const userMsg =
    String(turn.args.userMessage || args.userMessage).slice(0, 2500) ||
    args.userMessage

  try {
    switch (turn.tool) {
      case 'compose_full_trip': {
        const r = await composeFullTrip({
          trip: args.trip,
          userMessage: userMsg,
          signal: args.signal,
        })
        if (r.kind === 'need_clarification') {
          return {
            message: r.question,
            modeLabel: 'Listening',
            reason: turn.reason || 'Need a clearer region or vibe.',
            draft: args.draft,
            draftChanged: false,
            cards: [],
            checklist,
          }
        }
        if (r.kind === 'full_trip') {
          const whyLines = (r.draft.decisions || [])
            .slice(0, 3)
            .map((d) => `· ${d.what}: ${d.why}`)
            .join('\n')
          return {
            message:
              toolMsg ||
              [
                r.draft.summary ||
                  'Here’s a full trip sketch — scrub versions on the right, then apply when ready.',
                r.draft.spine.why ? `Why this route: ${r.draft.spine.why}` : '',
                whyLines ? `What I took into account:\n${whyLines}` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            modeLabel: 'Ready to apply',
            reason:
              turn.reason ||
              r.draft.spine.why ||
              'Built a day-by-day area spine from your vibe.',
            draft: mergeDraft(args.draft, r.draft),
            draftChanged: true,
            cards: [],
            checklist: mergeChecklist(checklist, {
              vibe: true,
              route: true,
              ready: true,
            }),
          }
        }
        break
      }
      case 'propose_spines': {
        const r = await requestSpineOptions({
          trip: args.trip,
          userMessage: userMsg,
          signal: args.signal,
        })
        if (r.kind === 'spine_options') {
          return {
            message:
              toolMsg ||
              'Here are a few route shapes — pick one to pin it on the trip tree.',
            modeLabel: 'Sketching a route',
            reason: turn.reason || 'Comparing geographic spines for your dates.',
            draft: args.draft,
            draftChanged: false,
            cards: [{ type: 'spine', options: r.options }],
            checklist: mergeChecklist(checklist, { vibe: true }),
          }
        }
        if (r.kind === 'need_clarification') {
          return {
            message: r.question,
            modeLabel: 'Listening',
            reason: turn.reason,
            draft: args.draft,
            draftChanged: false,
            cards: [],
            checklist,
          }
        }
        break
      }
      case 'area_tips': {
        const r = await requestAreaTips({
          trip: args.trip,
          userMessage: userMsg,
          countries: String(turn.args.area || turn.args.countries || ''),
          signal: args.signal,
        })
        if (r.kind === 'area_tips') {
          return {
            message:
              toolMsg ||
              'Neighborhood stay zones (not hotels) — pick one to pin on your day shells.',
            modeLabel: 'Comparing stay zones',
            reason: turn.reason || 'Looking for good areas to base each night.',
            draft: args.draft,
            draftChanged: false,
            cards: [{ type: 'tips', tips: r.tips }],
            checklist: mergeChecklist(checklist, { vibe: true }),
          }
        }
        break
      }
      case 'enrich': {
        const r = await requestEnrichment({
          trip: args.trip,
          userMessage: userMsg,
          signal: args.signal,
        })
        if (r.kind === 'enrich') {
          return {
            message:
              toolMsg ||
              (r.caveats.length
                ? 'A few must-knows for your areas:'
                : 'No strong caveats this round — ask if you want a deeper pass.'),
            modeLabel: 'Gathering must-knows',
            reason: turn.reason || 'Checking area-level details worth knowing.',
            draft: args.draft,
            draftChanged: false,
            cards: [
              {
                type: 'enrich',
                caveats: r.caveats.map((c) => ({
                  topic: c.topic,
                  summary: c.summary,
                })),
              },
            ],
            checklist: mergeChecklist(checklist, { details: true }),
          }
        }
        break
      }
      case 'area_knowhow': {
        const r = await requestAreaKnowHow({
          trip: args.trip,
          draft: args.draft,
          userMessage: userMsg,
          signal: args.signal,
        })
        return {
          message:
            toolMsg ||
            r.summary ||
            (r.areas.length
              ? 'Here’s where to base lodging searches and what to keep in mind per area:'
              : 'Need a route or stay zones first — then I can brief hotel neighborhoods.'),
          modeLabel: 'Gathering must-knows',
          reason:
            turn.reason ||
            'Briefing hotel-search neighborhoods and vibe fit so you feel ready.',
          draft: args.draft,
          draftChanged: false,
          cards: r.areas.length
            ? [{ type: 'knowhow', areas: r.areas, summary: r.summary }]
            : [],
          checklist: mergeChecklist(checklist, {
            details: true,
            ready: r.areas.length > 0,
          }),
        }
      }
      case 'reshape': {
        const r = await reshapeTrip({
          trip: args.trip,
          userMessage: userMsg,
          signal: args.signal,
        })
        if (r.kind === 'reshape') {
          const cards: TripHelperCard[] = []
          if (r.spineOptions?.length) {
            cards.push({ type: 'spine', options: r.spineOptions })
          }
          return {
            message: toolMsg || r.summary,
            modeLabel: 'Reshaping the trip',
            reason: turn.reason || 'Adjusting the sketch from what you said.',
            draft: args.draft,
            draftChanged: false,
            cards,
            checklist: mergeChecklist(checklist, { vibe: true }),
          }
        }
        if (r.kind === 'need_clarification') {
          return {
            message: r.question,
            modeLabel: 'Listening',
            reason: turn.reason,
            draft: args.draft,
            draftChanged: false,
            cards: [],
            checklist,
          }
        }
        break
      }
      case 'update_items': {
        // Re-ask compose with strong update bias using user message
        const r = await composeFullTrip({
          trip: args.trip,
          userMessage: `Update existing steps from this user info (prefer itemUpdates, do not duplicate flights):\n${userMsg}`,
          signal: args.signal,
        })
        if (r.kind === 'full_trip') {
          return {
            message:
              toolMsg ||
              'Updated flight/transit details on the sketch — check the tree, then apply.',
            modeLabel: 'Filling flight details',
            reason:
              turn.reason || 'Merged the times and airports you mentioned.',
            draft: mergeDraft(args.draft, r.draft),
            draftChanged: true,
            cards: [],
            checklist: mergeChecklist(checklist, {
              details: true,
              ready: Boolean(args.draft || r.draft),
            }),
          }
        }
        if (r.kind === 'need_clarification') {
          return {
            message: r.question,
            modeLabel: 'Filling flight details',
            reason: turn.reason,
            draft: args.draft,
            draftChanged: false,
            cards: [],
            checklist,
          }
        }
        break
      }
      case 'set_stay_zone': {
        // Usually handled in UI; if model asks, acknowledge
        return {
          message:
            toolMsg ||
            'Pick a stay-zone card to pin it on your day shells (not a hotel booking).',
          modeLabel: 'Comparing stay zones',
          reason: turn.reason,
          draft: args.draft,
          draftChanged: false,
          cards: [],
          checklist,
        }
      }
      default:
        break
    }
  } catch (e) {
    return {
      message: e instanceof Error ? e.message : 'Tool failed',
      modeLabel: turn.modeLabel,
      reason: turn.reason,
      draft: args.draft,
      draftChanged: false,
      cards: [],
      checklist,
    }
  }

  return {
    message: toolMsg || 'Done with that step — what next?',
    modeLabel: turn.modeLabel,
    reason: turn.reason,
    draft: args.draft,
    draftChanged: false,
    cards: [],
    checklist,
  }
}

/** Apply a chosen spine into the working draft. */
export function selectSpineDraft(
  trip: TripRecord,
  spine: TripSpineOption,
  prev: FullTripDraft | null,
): FullTripDraft {
  const base = spineToDraft(trip, spine)
  return mergeDraft(prev, base)
}

/** Run stay-zone adapt and return updated trip + human message. */
export async function applyStayZoneFromTip(args: {
  trip: TripRecord
  tip: AreaTip
  signal?: AbortSignal
}): Promise<{ trip: TripRecord; message: string }> {
  const next = await adaptSegmentToArea({
    trip: args.trip,
    dropAreaLabels: [],
    adopt: args.tip,
    signal: args.signal,
  })
  return {
    trip: next,
    message: `Stay zone set to ${args.tip.areaLabel} · day shells updated on the map (not a hotel).`,
  }
}

export function emptyChecklist(): TripChecklist {
  return { ...DEFAULT_CHECKLIST }
}

export function greetingForTrip(
  trip: TripRecord,
  opts?: { restarted?: boolean },
): {
  message: string
  modeLabel: TripChatModeLabel
  reason: string
} {
  const steps = existingStepsBrief(trip)
  const flights = steps.filter((s) => s.type === 'flight')
  const areas = prefsFromMeta(trip).adoptedAreas || []
  const otherCount = steps.filter((s) => s.type !== 'flight').length
  const areaBit = areas.length
    ? ` Stay zones on the Journey: ${areas.slice(0, 4).join(', ')}${
        areas.length > 4 ? '…' : ''
      }.`
    : ''
  const fresh = opts?.restarted
    ? 'Fresh start — prior chat and sketch drafts are cleared; I’m only using what’s on your Journey now.\n\n'
    : ''
  const ask = opts?.restarted
    ? ' What do you need next — reshape the route, pin stay zones, area know-how for hotels, or something else?'
    : ''

  if (flights.length) {
    const f = flights[0]!
    return {
      message: `${fresh}You’ve already got ${f.title || 'a flight'} on ${f.date}${
        f.from && f.to ? ` (${f.from}→${f.to})` : ''
      }.${
        otherCount
          ? ` Plus ${otherCount} other step${otherCount === 1 ? '' : 's'} on the timeline.`
          : ''
      }${areaBit}${
        opts?.restarted
          ? ask
          : ' Want me to build the rest of the trip around it, or reshape what you have?'
      }`,
      modeLabel: 'Listening',
      reason: opts?.restarted
        ? 'Restarted from the live Journey.'
        : 'Noticed existing transit on the Journey.',
    }
  }
  const days = trip.meta.startDate && trip.meta.endDate
  if (areas.length || otherCount) {
    return {
      message: `${fresh}${
        days
          ? `${trip.meta.name || 'Your trip'} (${trip.meta.startDate} → ${trip.meta.endDate}) already has shape on the Journey.`
          : 'Your Journey already has some shape.'
      }${areaBit}${
        otherCount
          ? ` ${otherCount} step${otherCount === 1 ? '' : 's'} on the timeline.`
          : ''
      }${
        opts?.restarted
          ? ask
          : ' Tell me what to refine — route, stay zones, or details — and I’ll pick the next step.'
      }`,
      modeLabel: 'Listening',
      reason: opts?.restarted
        ? 'Restarted from the live Journey.'
        : 'Picking up from what’s already on the Journey.',
    }
  }
  return {
    message: `${fresh}${
      days
        ? `Let’s sketch ${trip.meta.name || 'your trip'} (${trip.meta.startDate} → ${trip.meta.endDate}). Tell me the vibe, region, or paste any bookings — I’ll pick the right next step.`
        : 'Tell me where you want to go and the feel of the trip — I’ll sketch a route and stay zones (no invented hotels).'
    }${ask}`,
    modeLabel: 'Listening',
    reason: opts?.restarted
      ? 'Restarted from the live Journey.'
      : 'Starting from an open Journey.',
  }
}

/**
 * Clear chat + draft versions and greet from the live trip (hallucination / stuck recovery).
 */
export function restartConversationForTrip(trip: TripRecord): {
  message: string
  modeLabel: TripChatModeLabel
  reason: string
  checklist: TripChecklist
} {
  clearChatSession(trip.id)
  clearVersionStack(trip.id)
  const g = greetingForTrip(trip, { restarted: true })
  return {
    ...g,
    checklist: emptyChecklist(),
  }
}
