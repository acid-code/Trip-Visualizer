import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TripMeta, TripRecord } from '../domain/types'
import {
  buildCoachRequestBody,
  formatDayChipLabel,
  gatherCoachCandidates,
  requestCoachAdvice,
} from '../data/aiCoach'
import {
  briefingToPlanningHints,
  compileTripDayBriefing,
  rememberClarification,
} from '../agent'
import { describePatch } from '../data/aiCoachPatch'
import { itemTouchesDay, listTripDays } from '../data/dayBases'
import type { ExplorePlace } from '../data/explore'
import type {
  AiChatMessage,
  AiCoachOption,
  AiCoachOptionKind,
} from '../data/aiCoachTypes'
import { createId } from '../data/db'
import { TypewriterText } from './TypewriterText'
import { MOBILE_SHEET_HEIGHT, TOUCH_SCROLL_X } from './scrollGesture'

const AI_INPUT_MAX = 250

export type AiCoachSessionRestore = {
  day: string
  options: AiCoachOption[]
  appliedOptionIds: string[]
  candidates: ExplorePlace[]
  clarifications: string[]
  pendingCoachQuestion?: string | null
  seedIntent?: string | null
}

type Props = {
  open: boolean
  phone?: boolean
  meta: TripMeta
  trip: TripRecord
  placesEnabled: boolean
  googleApiKey?: string
  restore?: AiCoachSessionRestore | null
  onClose: () => void
  onDayPicked?: (day: string) => void
  onOpenTripPlanner?: () => void
  onTripPrefs?: (trip: TripRecord) => void
  onImplement: (args: {
    day: string
    option: AiCoachOption
    candidates: ExplorePlace[]
    session: AiCoachSessionRestore
  }) => void
  onSeedPlanOnly?: (args: {
    day: string
    option: AiCoachOption
    candidates: ExplorePlace[]
    session: AiCoachSessionRestore
  }) => void
}

type Phase = 'pick_day' | 'ask_help' | 'busy' | 'options'

const KIND_TONE: Record<AiCoachOptionKind, string> = {
  food: 'bg-orange-100 text-orange-800',
  highlight: 'bg-sky-100 text-sky-800',
  viewpoint: 'bg-lime-100 text-lime-900',
  pacing: 'bg-violet-100 text-violet-800',
  itinerary: 'bg-teal-100 text-teal-900',
  trim: 'bg-rose-100 text-rose-800',
  other: 'bg-stone-100 text-stone-700',
}

/** Shared hover/focus copy for Day Coach entry points. */
export const AI_COACH_BETA_TIP =
  'Day Coach is beta. Suggestions can be wrong or incomplete — review the preview carefully and only Save if the edits fit your trip.'

function PatchLines({
  option,
  candidates,
  dayItems,
}: {
  option: AiCoachOption
  candidates: ExplorePlace[]
  dayItems: Array<{ id: string; title: string }>
}) {
  const lines = describePatch(option, candidates, dayItems)
  return (
    <ul className="space-y-1 rounded-xl bg-stone-50 px-3 py-2 text-xs text-stone-600">
      {lines.map((line) => (
        <li key={line}>· {line}</li>
      ))}
      {!lines.length ? <li>· No concrete changes in this option</li> : null}
    </ul>
  )
}

function msg(
  role: 'assistant' | 'user',
  text: string,
  animate = role === 'assistant',
): AiChatMessage {
  return { id: createId('M'), role, text, animate }
}

export function AiCoachSheet({
  open,
  phone,
  meta,
  trip,
  placesEnabled,
  googleApiKey,
  restore = null,
  onClose,
  onDayPicked,
  onOpenTripPlanner,
  onTripPrefs,
  onImplement,
  onSeedPlanOnly,
}: Props) {
  const [phase, setPhase] = useState<Phase>('pick_day')
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [day, setDay] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<AiCoachOption[]>([])
  const [appliedOptionIds, setAppliedOptionIds] = useState<string[]>([])
  const [detail, setDetail] = useState<AiCoachOption | null>(null)
  const [candidates, setCandidates] = useState<ExplorePlace[]>([])
  const [clarifications, setClarifications] = useState<string[]>([])
  const [pendingCoachQuestion, setPendingCoachQuestion] = useState<string | null>(
    null,
  )
  const [seedIntent, setSeedIntent] = useState<string | null>(null)
  const [typingDone, setTypingDone] = useState(true)
  const abortRef = useRef<AbortController | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bootRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, 132) // ~5 lines
    el.style.height = `${Math.max(40, next)}px`
  }, [input, phase, busy])

  const days = useMemo(() => listTripDays(meta), [meta])

  const resetFresh = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase('pick_day')
    setMessages([
      msg('assistant', 'Which day should we improve?', true),
    ])
    setDay(null)
    setInput('')
    setBusy(false)
    setError(null)
    setOptions([])
    setAppliedOptionIds([])
    setDetail(null)
    setCandidates([])
    setClarifications([])
    setPendingCoachQuestion(null)
    setSeedIntent(null)
    setTypingDone(false)
    bootRef.current = true
  }, [])

  const applyRestore = useCallback((r: AiCoachSessionRestore) => {
    setPhase('options')
    setDay(r.day)
    setOptions(r.options)
    setAppliedOptionIds(r.appliedOptionIds)
    setCandidates(r.candidates)
    setClarifications(r.clarifications)
    setPendingCoachQuestion(r.pendingCoachQuestion ?? null)
    setSeedIntent(r.seedIntent ?? null)
    setDetail(null)
    setError(null)
    setBusy(false)
    setInput('')
    setMessages([
      msg('assistant', `Back on ${formatDayChipLabel(meta, r.day)}. What else can we help with?`, true),
    ])
    setTypingDone(false)
    bootRef.current = true
  }, [meta])

  useEffect(() => {
    if (!open) {
      bootRef.current = false
      return
    }
    if (bootRef.current) return
    if (restore?.day) applyRestore(restore)
    else resetFresh()
  }, [open, restore, applyRestore, resetFresh])

  useEffect(() => {
    if (!open) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [open, messages, options, detail, busy, phase])

  function pickDay(d: string) {
    if (phase !== 'pick_day' || !typingDone) return
    setDay(d)
    onDayPicked?.(d)
    setMessages((prev) => [
      ...prev,
      msg('user', formatDayChipLabel(meta, d), false),
      msg('assistant', 'What can we help with on this day?', true),
    ])
    setPhase('ask_help')
    setTypingDone(false)
  }

  async function sendIntent(text: string) {
    const trimmed = text.trim()
    if (!trimmed || !day || busy) return
    setInput('')
    setError(null)
    setOptions([])
    setDetail(null)
    setMessages((prev) => [...prev, msg('user', trimmed, false)])
    setBusy(true)
    setPhase('busy')

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    try {
      setMessages((prev) => [
        ...prev,
        msg('assistant', 'Looking it up…', true),
      ])
      setTypingDone(false)

      // Bind short follow-ups ("first one") to the pending coach question
      let clarPayload = [...clarifications]
      const gatherMessage = pendingCoachQuestion
        ? seedIntent || trimmed
        : trimmed
      if (pendingCoachQuestion) {
        const original = seedIntent || ''
        clarPayload = [
          ...clarifications.filter(
            (c) =>
              !c.startsWith('Coach asked:') &&
              !c.startsWith('User replied:') &&
              !c.startsWith('Original request:'),
          ),
          ...(original
            ? [`Original request: ${original.slice(0, 400)}`]
            : []),
          `Coach asked: ${pendingCoachQuestion.slice(0, 400)}`,
          `User replied: ${trimmed.slice(0, 400)}`,
        ].slice(-12)
      }

      const places = await gatherCoachCandidates(trip, day, {
        signal: ac.signal,
        useGooglePlaces: placesEnabled,
        googleApiKey,
        userMessage: gatherMessage,
      })
      if (ac.signal.aborted) return
      setCandidates(places)
      if (!places.length) {
        setMessages((prev) => [
          ...prev,
          msg(
            'assistant',
            'Nearby search could not reach Google Places or OpenStreetMap from this machine. Restart `npm run dev` after pulling proxy fixes, check the Places API (New) is enabled for your key, and that outbound HTTPS works. I can still suggest pacing from your existing steps.',
            true,
          ),
        ])
        setTypingDone(false)
      }

      if (pendingCoachQuestion) {
        onTripPrefs?.(rememberClarification(trip, trimmed))
      }

      const briefing = compileTripDayBriefing(trip, day)
      const body = buildCoachRequestBody({
        trip,
        day,
        userMessage: pendingCoachQuestion
          ? `${gatherMessage}\n\n(Follow-up answer: ${trimmed})`
          : trimmed,
        clarifications: clarPayload,
        candidates: places,
      })
      body.planningHints = [
        ...(body.planningHints || []),
        ...briefingToPlanningHints(briefing),
      ].slice(0, 20)
      const result = await requestCoachAdvice(body, places, ac.signal)
      if (ac.signal.aborted) return

      if (result.kind === 'need_clarification') {
        if (!seedIntent) setSeedIntent(trimmed)
        setPendingCoachQuestion(result.question)
        setClarifications(clarPayload)
        setMessages((prev) => [...prev, msg('assistant', result.question, true)])
        setTypingDone(false)
        setPhase('ask_help')
        return
      }

      setPendingCoachQuestion(null)
      setClarifications(clarPayload)
      setSeedIntent(null)
      setOptions(result.options)
      setMessages((prev) => [
        ...prev,
        msg(
          'assistant',
          result.options.length > 1
            ? 'Here are a few options — pick one to review.'
            : places.length
              ? 'Here’s an option to review.'
              : 'Limited options without nearby POIs — pick one to review, or fix network and ask again.',
          true,
        ),
      ])
      setTypingDone(false)
      setPhase('options')
    } catch (e) {
      if (ac.signal.aborted) return
      setError(e instanceof Error ? e.message : 'Coach failed')
      setPhase(day ? 'ask_help' : 'pick_day')
    } finally {
      if (!ac.signal.aborted) setBusy(false)
    }
  }

  function closeSheet() {
    abortRef.current?.abort()
    bootRef.current = false
    onClose()
  }

  if (!open) return null

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col bg-gradient-to-b from-[#12182a] via-[#0e1522] to-[#0a1018] ${
        phone ? '' : ''
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-violet-100/80 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
            <AiSparkIcon className="h-3.5 w-3.5" />
            Day Coach
            <span
              className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold normal-case tracking-normal text-violet-800"
              title={AI_COACH_BETA_TIP}
            >
              Beta
            </span>
          </div>
          <p className="truncate text-xs text-stone-500" title={AI_COACH_BETA_TIP}>
            {day
              ? formatDayChipLabel(meta, day)
              : 'Pick a day · review before you accept'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenTripPlanner ? (
            <button
              type="button"
              className="rounded-full border border-violet-400/40 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-200"
              title="Total Trip AI — create a full trip from the model"
              onClick={() => onOpenTripPlanner()}
            >
              Whole trip
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600"
            title="Close AI"
            onClick={closeSheet}
          >
            ✕
          </button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-3"
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {messages.map((m, idx) => {
          const isLast = idx === messages.length - 1
          const animate = Boolean(m.animate && isLast && m.role === 'assistant')
          return (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-snug shadow-sm ${
                  m.role === 'user'
                    ? 'rounded-br-md bg-violet-600 text-white'
                    : 'rounded-bl-md border border-violet-100 bg-white text-stone-800'
                }`}
              >
                {animate ? (
                  <TypewriterText
                    text={m.text}
                    onDone={() => setTypingDone(true)}
                  />
                ) : (
                  m.text
                )}
              </div>
            </div>
          )
        })}

        {phase === 'pick_day' && typingDone ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {days.map((d) => (
              <button
                key={d}
                type="button"
                className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-violet-900 shadow-sm hover:border-violet-400 hover:bg-violet-50"
                onClick={() => pickDay(d)}
              >
                {formatDayChipLabel(meta, d)}
              </button>
            ))}
          </div>
        ) : null}

        {busy ? (
          <p className="text-center text-xs text-violet-500">Looking around & thinking…</p>
        ) : null}
        {error ? (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        ) : null}

        {phase === 'options' && options.length ? (
          <div className="pt-1">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
              Options
            </div>
            <div className={`flex gap-2.5 pb-1 [scrollbar-width:thin] ${TOUCH_SCROLL_X}`}>
              {options.map((opt) => {
                const applied = appliedOptionIds.includes(opt.id)
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDetail(opt)}
                    className={`w-[11.5rem] shrink-0 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition ${
                      applied
                        ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300'
                        : 'border-stone-200 bg-white hover:border-violet-300'
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-1">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${KIND_TONE[opt.kind]}`}
                      >
                        {opt.kind}
                      </span>
                      {applied ? (
                        <span className="text-[9px] font-bold uppercase text-emerald-700">
                          Applied
                        </span>
                      ) : null}
                    </div>
                    <div className="text-sm font-semibold text-stone-900">{opt.label}</div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-stone-500">
                      {opt.summary}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      {(phase === 'ask_help' || phase === 'options') && !busy ? (
        <form
          className="flex shrink-0 items-end gap-2 border-t border-violet-100 bg-white/80 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            void sendIntent(input)
          }}
        >
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              maxLength={AI_INPUT_MAX}
              onChange={(e) => setInput(e.target.value.slice(0, AI_INPUT_MAX))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (input.trim() && typingDone) void sendIntent(input)
                }
              }}
              placeholder={
                phase === 'options'
                  ? 'Ask for something else…'
                  : 'e.g. lunch near the museum, viewpoints on the drive…'
              }
              className="max-h-[8.25rem] min-h-[2.5rem] w-full resize-none overflow-y-auto rounded-xl border border-stone-200 bg-white px-3 py-2 pr-12 text-sm leading-snug text-stone-800 outline-none ring-violet-300 focus:ring-2"
              disabled={!typingDone}
            />
            <span
              className={`pointer-events-none absolute bottom-2 right-2 text-[10px] tabular-nums ${
                input.length >= AI_INPUT_MAX
                  ? 'text-rose-500'
                  : input.length >= AI_INPUT_MAX - 40
                    ? 'text-amber-600'
                    : 'text-stone-400'
              }`}
            >
              {input.length}/{AI_INPUT_MAX}
            </span>
          </div>
          <button
            type="submit"
            disabled={!input.trim() || !typingDone}
            className="mb-0.5 rounded-xl bg-violet-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      ) : null}

      {detail ? (
        <div className="absolute inset-0 z-20 flex flex-col bg-stone-950/25 backdrop-blur-[2px]">
          <div className={`mt-auto ${MOBILE_SHEET_HEIGHT.aiCoachDetail} overflow-y-auto overscroll-contain touch-pan-y rounded-t-3xl border border-stone-200 bg-white shadow-2xl`}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-stone-100 bg-white/95 px-4 py-2.5 backdrop-blur">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
                  {detail.kind}
                </div>
                <h3 className="truncate text-sm font-semibold text-stone-900">
                  {detail.label}
                </h3>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-600"
                title="Back to options"
                onClick={() => setDetail(null)}
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 px-4 py-3">
              <p className="text-sm text-stone-700">{detail.rationale || detail.summary}</p>
              <PatchLines
                option={detail}
                candidates={candidates}
                dayItems={
                  day
                    ? trip.items
                        .filter((i) => itemTouchesDay(i, day))
                        .map((i) => ({ id: i.id, title: i.title }))
                    : []
                }
              />
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="w-full rounded-2xl bg-violet-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700"
                  onClick={() => {
                    if (!day) return
                    const session: AiCoachSessionRestore = {
                      day,
                      options,
                      appliedOptionIds,
                      candidates,
                      clarifications,
                      pendingCoachQuestion,
                      seedIntent,
                    }
                    onImplement({ day, option: detail, candidates, session })
                    setDetail(null)
                  }}
                >
                  Implement on Journey
                </button>
                {onSeedPlanOnly && (detail.patch.addPlanPlaces?.length || detail.patch.addSteps?.length) ? (
                  <button
                    type="button"
                    className="w-full rounded-2xl border border-teal-300 bg-teal-50 py-2 text-sm font-semibold text-teal-900"
                    onClick={() => {
                      if (!day) return
                      const session: AiCoachSessionRestore = {
                        day,
                        options,
                        appliedOptionIds,
                        candidates,
                        clarifications,
                        pendingCoachQuestion,
                        seedIntent,
                      }
                      onSeedPlanOnly({ day, option: detail, candidates, session })
                      setDetail(null)
                    }}
                  >
                    Add to Plan lists only
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AiSparkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2.2 13.7 8.3 19.8 10 13.7 11.7 12 17.8 10.3 11.7 4.2 10 10.3 8.3 12 2.2Z" />
      <path
        d="M18.2 14.2 19 16.8 21.6 17.6 19 18.4 18.2 21 17.4 18.4 14.8 17.6 17.4 16.8 18.2 14.2Z"
        opacity="0.85"
      />
      <path
        d="M6.4 13.5 7 15.4 8.9 16 7 16.6 6.4 18.5 5.8 16.6 3.9 16 5.8 15.4 6.4 13.5Z"
        opacity="0.7"
      />
    </svg>
  )
}
