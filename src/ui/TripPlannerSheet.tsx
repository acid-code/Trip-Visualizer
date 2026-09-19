/**
 * Whole Trip AI — chat agent with live trip-shape tree, versions, Cursor-like chrome.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TripRecord } from '../domain/types'
import {
  applyFullTripDraftWithPlaces,
  applyStayZoneFromTip,
  clearPlaceProviderCache,
  emptyChecklist,
  fingerprintLiveTrip,
  formatSketchStamp,
  formatTripStructureText,
  getCachedPlaceProvider,
  greetingForTrip,
  loadSketchStack,
  placeProviderLabel,
  reconcileStructureDrift,
  resolvePlaceProvider,
  restartConversationForTrip,
  runTripHelper,
  selectSpineDraft,
  sketchAuthorLabel,
  stackFingerprint,
  tripWithAiSketch,
  tripWithoutAiSketch,
  versionStackFromAiSketch,
  type FullTripDraft,
  type TripChatModeLabel,
  type TripChecklist,
  type TripHelperCard,
  type TripHelperMessage,
} from '../agent'
import {
  currentVersion,
  pushDraftVersion,
  saveVersionStack,
  scrubVersion,
  type VersionStack,
} from '../agent/draftVersions'
import {
  loadChatSession,
  saveChatSession,
} from '../agent/chatSession'
import { createId } from '../data/db'
import { AiSparkIcon } from './AiCoachSheet'
import {
  ChatBubbleText,
  extractChoiceChips,
} from './ChatBubbleText'
import { TripShapeTree } from './TripShapeTree'
import { TOUCH_SCROLL_Y } from './scrollGesture'

type Props = {
  open: boolean
  phone?: boolean
  trip: TripRecord
  onClose: () => void
  /** Immediate persist (e.g. stay-zone tip). */
  onApplyTrip: (trip: TripRecord, message?: string) => void
  /** Smart-merge preview on Journey — Save / Discard in AI review chrome. */
  onPreviewApply: (trip: TripRecord, label: string) => void
  /** Injected after Discard — ask what to improve. */
  resumePrompt?: string | null
  onResumeConsumed?: () => void
  /** Signed-in user — stamps shared sketches with who authored them. */
  sketchAuthor?: {
    uid: string
    email: string
    displayName: string
  } | null
}

type ChatMsg = TripHelperMessage & { id: string }

const CHECK_LABELS: Array<{ key: keyof TripChecklist; label: string }> = [
  { key: 'vibe', label: 'Vibe' },
  { key: 'route', label: 'Route' },
  { key: 'stayZones', label: 'Stay zones' },
  { key: 'details', label: 'Details' },
  { key: 'ready', label: 'Ready' },
]

const THINKING_LINES = [
  'Reading your Journey…',
  'Weighing stay zones…',
  'Sketching the next step…',
  'Checking what already fits…',
  'Looking for a cleaner route…',
]

export function TripPlannerSheet({
  open,
  phone,
  trip,
  onClose,
  onApplyTrip,
  onPreviewApply,
  resumePrompt,
  onResumeConsumed,
  sketchAuthor,
}: Props) {
  const [providerLabel, setProviderLabel] = useState('')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modeLabel, setModeLabel] = useState<TripChatModeLabel>('Listening')
  const [reason, setReason] = useState('')
  const [checklist, setChecklist] = useState<TripChecklist>(emptyChecklist)
  const [cards, setCards] = useState<TripHelperCard[]>([])
  const [stack, setStack] = useState<VersionStack>({ versions: [], index: -1 })
  const [applying, setApplying] = useState(false)
  const [copyFlash, setCopyFlash] = useState(false)
  const [copiedBubbleId, setCopiedBubbleId] = useState<string | null>(null)
  const [chatCopyFlash, setChatCopyFlash] = useState(false)
  const [thinkingLine, setThinkingLine] = useState(THINKING_LINES[0]!)
  const [present, setPresent] = useState(open)
  const [entered, setEntered] = useState(false)
  const [shapeMotion, setShapeMotion] = useState<
    'next' | 'prev' | 'update' | null
  >(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const bootRef = useRef(false)
  const driftKeyRef = useRef('')
  const prevVersionIdRef = useRef<string | null>(null)
  /** Ignore echo of our own sketch writes when partner sync updates trip. */
  const sketchAtRef = useRef(0)

  const activeVersion = currentVersion(stack)
  const draft = activeVersion?.draft ?? null

  useEffect(() => {
    if (open) {
      setPresent(true)
      const id = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setEntered(true))
      })
      return () => window.cancelAnimationFrame(id)
    }
    setEntered(false)
    const t = window.setTimeout(() => setPresent(false), 300)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    // Re-probe when last known provider was OSM so Google can recover after quota returns.
    if (getCachedPlaceProvider() === 'osm') {
      clearPlaceProviderCache()
    }
    void resolvePlaceProvider().then((p) => setProviderLabel(placeProviderLabel(p)))
  }, [open])

  // Shape panel motion when the active version changes
  useEffect(() => {
    const id = activeVersion?.id ?? null
    if (!id) {
      prevVersionIdRef.current = null
      return
    }
    if (prevVersionIdRef.current && prevVersionIdRef.current !== id) {
      setShapeMotion((m) => m ?? 'update')
      const t = window.setTimeout(() => setShapeMotion(null), 480)
      prevVersionIdRef.current = id
      return () => window.clearTimeout(t)
    }
    prevVersionIdRef.current = id
  }, [activeVersion?.id])

  const authorStamp = useCallback(() => {
    if (!trip.shareEnabled || !sketchAuthor?.uid) return {}
    const byLabel = sketchAuthorLabel(sketchAuthor)
    if (!byLabel) return {}
    return {
      byUid: sketchAuthor.uid,
      byLabel,
      byEmail: sketchAuthor.email || undefined,
    }
  }, [trip.shareEnabled, sketchAuthor])

  const pushVersion = useCallback(
    (
      nextDraft: FullTripDraft,
      label: string,
      mode: TripChatModeLabel,
      why: string,
    ) => {
      setShapeMotion('update')
      setStack((prev) => {
        const next = pushDraftVersion(trip.id, prev, {
          label,
          reason: why,
          mode,
          draft: nextDraft,
          ...authorStamp(),
        })
        stackRef.current = next
        const withSketch = tripWithAiSketch(trip, next)
        sketchAtRef.current = withSketch.aiSketch?.updatedAt ?? Date.now()
        onApplyTrip(withSketch)
        return next
      })
    },
    [trip, onApplyTrip, authorStamp],
  )

  function scrub(delta: -1 | 1) {
    setShapeMotion(delta < 0 ? 'prev' : 'next')
    setStack((s) => {
      const next = scrubVersion(trip.id, s, s.index + delta)
      stackRef.current = next
      const withSketch = tripWithAiSketch(trip, next)
      sketchAtRef.current = withSketch.aiSketch?.updatedAt ?? Date.now()
      onApplyTrip(withSketch)
      return next
    })
  }

  function closeSheet() {
    abortRef.current?.abort()
    bootRef.current = false
    setEntered(false)
    onClose()
  }

  const applyDrift = useCallback(
    (prev: VersionStack, nextTrip: TripRecord): VersionStack => {
      const tripFp = fingerprintLiveTrip(nextTrip)
      const key = `${nextTrip.id}|${tripFp}`
      if (driftKeyRef.current === key) return prev
      const v = currentVersion(prev)
      if (!v?.draft) return prev
      const result = reconcileStructureDrift(v.draft, nextTrip)
      driftKeyRef.current = key
      if (result.kind === 'none') return prev
      if (result.kind === 'auto') {
        setModeLabel('Reshaping the trip')
        setReason(result.summary)
        setMessages((msgs) => [
          ...msgs,
          {
            id: createId('M'),
            role: 'assistant',
            text: result.summary,
          },
        ])
        return pushDraftVersion(nextTrip.id, prev, {
          label: result.draft.spine.label || v.label,
          reason: result.summary,
          mode: 'Reshaping the trip',
          draft: result.draft,
          ...authorStamp(),
        })
      }
      setModeLabel('Listening')
      setReason(result.summary)
      setMessages((msgs) => [
        ...msgs,
        {
          id: createId('M'),
          role: 'assistant',
          text: [
            result.summary,
            '',
            ...result.questions.map((q, i) => `${i + 1}. ${q}`),
          ].join('\n'),
        },
      ])
      return prev
    },
    [authorStamp],
  )

  const stackRef = useRef(stack)
  stackRef.current = stack

  useEffect(() => {
    if (!open) {
      bootRef.current = false
      driftKeyRef.current = ''
      return
    }
    if (bootRef.current) return
    bootRef.current = true

    const saved = loadChatSession(trip.id)
    const g = greetingForTrip(trip)
    const msgs: ChatMsg[] = saved?.messages.length
      ? saved.messages.map((m) => ({ ...m }))
      : [{ id: createId('M'), role: 'assistant', text: g.message }]

    if (resumePrompt?.trim()) {
      msgs.push({
        id: createId('M'),
        role: 'assistant',
        text: resumePrompt.trim(),
      })
      setModeLabel('Listening')
      setReason('Tell me what to change for a better merge.')
      onResumeConsumed?.()
    } else if (saved) {
      setModeLabel(saved.modeLabel)
      setReason(saved.reason)
    } else {
      setModeLabel(g.modeLabel)
      setReason(g.reason)
    }

    setMessages(msgs)
    setChecklist(saved?.checklist ?? emptyChecklist())
    setCards([])
    setError('')
    setInput('')
    setCopyFlash(false)
    // Sketches: shared trip.aiSketch first (partners see the same tip).
    // Chat: local session only — never on the shared trip.
    const loaded = loadSketchStack(trip)
    const nextStack = applyDrift(loaded, trip)
    stackRef.current = nextStack
    sketchAtRef.current = trip.aiSketch?.updatedAt ?? 0
    setStack(nextStack)
    if (nextStack !== loaded) {
      const withSketch = tripWithAiSketch(trip, nextStack)
      sketchAtRef.current = withSketch.aiSketch?.updatedAt ?? Date.now()
      onApplyTrip(withSketch)
    }
  }, [open, trip, applyDrift, resumePrompt, onResumeConsumed, onApplyTrip])

  // Persist full transcript (user + assistant) so reopen doesn't feel cut off.
  // Intentionally device-local — not written onto TripRecord / share.
  useEffect(() => {
    if (!open || !bootRef.current) return
    if (!messages.length) return
    saveChatSession(trip.id, {
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
      })),
      modeLabel,
      reason,
      checklist,
    })
  }, [open, trip.id, messages, modeLabel, reason, checklist])

  // Partner (or other device) pushed a newer sketch — adopt it; keep our chat.
  useEffect(() => {
    if (!open || !bootRef.current) return
    const remoteAt = trip.aiSketch?.updatedAt ?? 0
    if (!remoteAt || remoteAt <= sketchAtRef.current) return
    const remote = versionStackFromAiSketch(trip.aiSketch)
    if (stackFingerprint(remote) === stackFingerprint(stackRef.current)) {
      sketchAtRef.current = remoteAt
      return
    }
    sketchAtRef.current = remoteAt
    const next = applyDrift(remote, trip)
    stackRef.current = next
    saveVersionStack(trip.id, next)
    setStack(next)
  }, [open, trip, applyDrift])

  // Journey edited while the sheet is open — re-check drift.
  useEffect(() => {
    if (!open || !bootRef.current) return
    const prev = stackRef.current
    const next = applyDrift(prev, trip)
    if (next === prev) return
    stackRef.current = next
    setStack(next)
    const withSketch = tripWithAiSketch(trip, next)
    sketchAtRef.current = withSketch.aiSketch?.updatedAt ?? Date.now()
    onApplyTrip(withSketch)
  }, [open, trip, applyDrift, onApplyTrip])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, cards, busy])

  useEffect(() => {
    if (!busy) return
    setThinkingLine(
      THINKING_LINES[Math.floor(Math.random() * THINKING_LINES.length)]!,
    )
    const t = window.setInterval(() => {
      setThinkingLine((prev) => {
        const idx = THINKING_LINES.indexOf(prev)
        return THINKING_LINES[(idx + 1) % THINKING_LINES.length]!
      })
    }, 2200)
    return () => window.clearInterval(t)
  }, [busy])

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const choiceChips =
    !busy && lastAssistant ? extractChoiceChips(lastAssistant.text) : []

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || busy) return
      setInput('')
      setError('')
      setBusy(true)
      const userMsg: ChatMsg = {
        id: createId('M'),
        role: 'user',
        text: trimmed,
      }
      const transcript: TripHelperMessage[] = [
        ...messages.map((m) => ({ role: m.role, text: m.text })),
        { role: 'user', text: trimmed },
      ]
      setMessages((prev) => [...prev, userMsg])
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      try {
        const result = await runTripHelper({
          trip,
          userMessage: trimmed,
          transcript,
          draft,
          checklist,
          signal: ac.signal,
        })
        if (ac.signal.aborted) return
        setModeLabel(result.modeLabel)
        setReason(result.reason)
        setChecklist(result.checklist)
        setCards(result.cards)
        setMessages((prev) => [
          ...prev,
          {
            id: createId('M'),
            role: 'assistant',
            text: result.message,
          },
        ])
        if (result.draftChanged && result.draft) {
          pushVersion(
            result.draft,
            result.draft.spine.label || 'Trip sketch',
            result.modeLabel,
            result.reason,
          )
        }
        if (result.stayZoneTrip) {
          onApplyTrip(result.stayZoneTrip, result.stayZoneMessage)
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Something went wrong')
        }
      } finally {
        if (!ac.signal.aborted) setBusy(false)
      }
    },
    [busy, messages, trip, draft, checklist, pushVersion, onApplyTrip],
  )

  const restartConversation = useCallback(() => {
    if (busy || applying) return
    abortRef.current?.abort()
    setBusy(false)
    const g = restartConversationForTrip(trip)
    const empty: VersionStack = { versions: [], index: -1 }
    stackRef.current = empty
    setStack(empty)
    // Clear shared sketches for partners; chat was already cleared locally.
    const cleared = tripWithoutAiSketch(trip)
    sketchAtRef.current = Date.now()
    onApplyTrip(cleared)
    setMessages([
      { id: createId('M'), role: 'assistant', text: g.message },
    ])
    setModeLabel(g.modeLabel)
    setReason(g.reason)
    setChecklist(g.checklist)
    setCards([])
    setError('')
    setInput('')
    setCopyFlash(false)
    prevVersionIdRef.current = null
  }, [busy, applying, trip, onApplyTrip])

  async function applySelected() {
    const v = currentVersion(stack)
    if (!v?.draft || applying) return
    setApplying(true)
    setModeLabel('Ready to apply')
    setReason('Building a smart merge preview on your Journey…')
    try {
      const next = await applyFullTripDraftWithPlaces(trip, v.draft)
      onPreviewApply(next, v.label || v.draft.spine.label || 'Whole Trip')
      closeSheet()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setApplying(false)
    }
  }

  if (!present) return null

  const versionLabel =
    stack.index >= 0
      ? `v${stack.index + 1}/${stack.versions.length}`
      : 'no draft yet'
  const sketchedAt = activeVersion?.at
  const sketchedLabel = sketchedAt
    ? formatSketchStamp(sketchedAt, activeVersion?.byLabel)
    : ''
  const shapeAnimClass =
    shapeMotion === 'next'
      ? 'trip-planner-shape-next'
      : shapeMotion === 'prev'
        ? 'trip-planner-shape-prev'
        : shapeMotion === 'update'
          ? 'trip-planner-shape-update'
          : ''

  async function copyToClipboard(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) return false
    try {
      await navigator.clipboard.writeText(trimmed)
      return true
    } catch {
      setError('Could not copy — try selecting the text manually')
      return false
    }
  }

  async function copyStructure() {
    const text = formatTripStructureText(draft, trip, {
      sketchedAt: activeVersion?.at,
      sketchedBy: activeVersion?.byLabel,
    })
    if (!text) return
    if (await copyToClipboard(text)) {
      setCopyFlash(true)
      window.setTimeout(() => setCopyFlash(false), 1600)
    }
  }

  async function copyBubble(id: string, text: string) {
    if (!(await copyToClipboard(text))) return
    setCopiedBubbleId(id)
    window.setTimeout(() => {
      setCopiedBubbleId((cur) => (cur === id ? null : cur))
    }, 1600)
  }

  async function copyConversation() {
    if (!messages.length) return
    const text = messages
      .map((m) => `${m.role === 'user' ? 'You' : 'Coach'}:\n${m.text.trim()}`)
      .join('\n\n')
    if (await copyToClipboard(text)) {
      setChatCopyFlash(true)
      window.setTimeout(() => setChatCopyFlash(false), 1600)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close Whole Trip"
        className={`trip-planner-backdrop ${entered ? 'trip-planner-backdrop-in' : ''}`}
        onClick={closeSheet}
      />
      <div
        className={`trip-planner-sheet fixed inset-x-0 z-[80] flex flex-col overflow-hidden rounded-t-[1.35rem] border-t border-violet-500/25 bg-gradient-to-b from-[#12182a] via-[#0e1522] to-[#0a1018] shadow-2xl shadow-violet-950/50 ${
          entered ? 'trip-planner-sheet-in' : 'trip-planner-sheet-out'
        } ${phone ? 'bottom-0' : 'bottom-0 left-auto right-0 w-full max-w-2xl'}`}
        style={{ height: phone ? '90vh' : 'min(90vh, 780px)' }}
        role="dialog"
        aria-label="Whole Trip AI"
      >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-violet-100/10 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
            <AiSparkIcon
              className={`h-3.5 w-3.5 ${busy || applying ? 'trip-planner-spark-busy' : ''}`}
            />
            Whole Trip
            <span className="rounded-md bg-violet-100/90 px-1.5 py-0.5 text-[9px] font-bold normal-case tracking-normal text-violet-800">
              Beta
            </span>
          </div>
          <p className="truncate text-[11px] text-stone-400">
            {trip.meta.startDate} → {trip.meta.endDate}
            {providerLabel ? ` · ${providerLabel}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="trip-planner-btn flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-stone-300 hover:bg-white/10"
          onClick={closeSheet}
          title="Close"
        >
          ✕
        </button>
      </header>

      {/* Cursor-like mode / why */}
      <div className="shrink-0 border-b border-white/5 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`trip-planner-mode-pill rounded-full bg-violet-600/90 px-2.5 py-0.5 text-[10px] font-semibold text-white ${
              busy || applying ? 'trip-planner-mode-busy' : ''
            }`}
          >
            {applying ? 'Previewing…' : busy ? 'Working…' : modeLabel}
          </span>
          <span className="text-[10px] text-violet-200/55">
            {trip.meta.name || 'Untitled trip'}
          </span>
        </div>
        {reason ? (
          <p className="trip-planner-reason mt-1 text-[11px] leading-snug text-violet-100/65">
            {reason}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {CHECK_LABELS.map(({ key, label }) => (
            <span
              key={key}
              className={`trip-planner-check rounded-full px-2 py-0.5 text-[9px] font-medium ${
                checklist[key]
                  ? 'trip-planner-check-on bg-violet-500/30 text-violet-100'
                  : 'bg-white/5 text-violet-300/40'
              }`}
            >
              {checklist[key] ? '✓ ' : ''}
              {label}
            </span>
          ))}
        </div>
      </div>

      <div
        className={`flex min-h-0 flex-1 ${phone ? 'flex-col' : 'flex-row'}`}
      >
        {/* Chat column */}
        <div
          className={`flex min-h-0 flex-col ${phone ? 'h-[48%] border-b border-white/5' : 'w-[55%] border-r border-white/5'}`}
        >
          <div
            ref={scrollerRef}
            className={`min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3 ${TOUCH_SCROLL_Y}`}
          >
            {messages.map((m, mi) => {
              const isLatest = mi === messages.length - 1
              const bubbleCopied = copiedBubbleId === m.id
              return (
              <div
                key={m.id}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[92%] rounded-2xl px-3 py-2.5 shadow-sm ${
                    isLatest ? 'trip-planner-bubble-in' : ''
                  } ${
                    m.role === 'user'
                      ? 'trip-planner-bubble-user rounded-br-md bg-violet-600 text-white'
                      : 'rounded-bl-md border border-white/5 bg-white/[0.06] text-violet-50'
                  }`}
                >
                  <ChatBubbleText
                    text={m.text}
                    onAccent={m.role === 'user'}
                  />
                  <div
                    className={`mt-1.5 flex ${
                      m.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <button
                      type="button"
                      className={`trip-planner-btn rounded-md px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                        m.role === 'user'
                          ? 'text-white/55 hover:bg-white/15 hover:text-white/90'
                          : 'text-violet-200/45 hover:bg-white/10 hover:text-violet-100/80'
                      } ${bubbleCopied ? 'trip-planner-copy-flash text-emerald-200/90' : ''}`}
                      title="Copy this message"
                      onClick={() => void copyBubble(m.id, m.text)}
                    >
                      {bubbleCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </div>
              )
            })}

            {busy ? (
              <div className="trip-planner-thinking" aria-live="polite">
                <span className="trip-planner-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                <span key={thinkingLine} className="trip-planner-reason">
                  {thinkingLine}
                </span>
              </div>
            ) : null}

            {choiceChips.length >= 1 ? (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {choiceChips.map((chip, i) => (
                  <button
                    key={`${chip.slice(0, 24)}-${i}`}
                    type="button"
                    disabled={busy}
                    className="trip-planner-chip trip-planner-btn max-w-full rounded-full border border-violet-400/30 bg-violet-500/15 px-2.5 py-1 text-left text-[11px] font-medium leading-snug text-violet-100 hover:bg-violet-500/25 disabled:opacity-40"
                    style={{ animationDelay: `${i * 40}ms` }}
                    onClick={() => void send(chip)}
                  >
                    {chip.length > 72 ? `${chip.slice(0, 70)}…` : chip}
                  </button>
                ))}
              </div>
            ) : null}

            {cards.map((card, ci) => (
              <div
                key={ci}
                className="trip-planner-card-in space-y-2"
                style={{ animationDelay: `${Math.min(ci, 4) * 60}ms` }}
              >
                {card.type === 'spine'
                  ? card.options.map((s, si) => (
                      <div
                        key={s.id || s.label}
                        className="trip-planner-card-in rounded-2xl border border-violet-400/25 bg-violet-500/10 px-3 py-2"
                        style={{ animationDelay: `${si * 70}ms` }}
                      >
                        <div className="text-sm font-semibold text-violet-50">
                          {s.label}
                        </div>
                        <p className="text-xs text-violet-100/65">{s.summary}</p>
                        {s.why ? (
                          <p className="mt-1 text-[11px] text-violet-200/70">
                            <span className="font-semibold text-violet-100/90">Why: </span>
                            {s.why}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[11px] text-violet-200/45">
                          {s.areas.map((a) => a.label).join(' → ')}
                        </p>
                        <button
                          type="button"
                          className="trip-planner-btn mt-2 rounded-xl bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-md shadow-violet-950/30"
                          onClick={() => {
                            const next = selectSpineDraft(trip, s, draft)
                            const withWhy: typeof next = {
                              ...next,
                              decisions: [
                                ...(next.decisions || []),
                                ...(s.why
                                  ? [
                                      {
                                        what: `Chose route “${s.label}”`,
                                        why: s.why,
                                      },
                                    ]
                                  : []),
                                ...s.areas
                                  .filter((a) => a.why)
                                  .map((a) => ({
                                    what: `Stay near ${a.label}`,
                                    why: a.why!,
                                  })),
                              ].slice(0, 16),
                              spine: { ...next.spine, why: s.why || next.spine.why },
                            }
                            pushVersion(
                              withWhy,
                              s.label,
                              'Sketching a route',
                              s.why || `Pinned route: ${s.label}`,
                            )
                            setModeLabel('Ready to apply')
                            setReason(
                              s.why || `Using route “${s.label}” on the trip tree.`,
                            )
                            setChecklist((c) => ({
                              ...c,
                              route: true,
                              vibe: true,
                              ready: true,
                            }))
                            setMessages((prev) => [
                              ...prev,
                              {
                                id: createId('M'),
                                role: 'assistant',
                                text: s.why
                                  ? `Pinned “${s.label}”. ${s.why} Scrub versions on the right, or ask me to refine stay zones.`
                                  : `Pinned “${s.label}” on the tree. Scrub versions on the right, or ask me to refine stay zones.`,
                              },
                            ])
                          }}
                        >
                          Use this route
                        </button>
                      </div>
                    ))
                  : null}
                {card.type === 'tips'
                  ? card.tips.map((tip, ti) => (
                      <div
                        key={tip.id || tip.areaLabel}
                        className="trip-planner-card-in rounded-2xl border border-violet-400/25 bg-violet-500/10 px-3 py-2"
                        style={{ animationDelay: `${ti * 70}ms` }}
                      >
                        <div className="text-sm font-semibold text-violet-50">
                          {tip.areaLabel}
                        </div>
                        <p className="text-xs text-violet-100/65">{tip.whyGo}</p>
                        <p className="mt-1 text-[10px] text-violet-200/50">
                          Pins this area on day shells — not a hotel
                        </p>
                        {tip.neighborhoods[0]?.whyStayHere ? (
                          <p className="mt-1 text-[11px] text-violet-200/70">
                            <span className="font-semibold text-violet-100/90">Why stay here: </span>
                            {tip.neighborhoods[0].whyStayHere}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          className="trip-planner-btn mt-2 rounded-xl bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-md shadow-violet-950/30 disabled:opacity-40"
                          onClick={() =>
                            void (async () => {
                              setBusy(true)
                              try {
                                const { trip: next, message } =
                                  await applyStayZoneFromTip({ trip, tip })
                                onApplyTrip(next, message)
                                setChecklist((c) => ({
                                  ...c,
                                  stayZones: true,
                                }))
                                setModeLabel('Comparing stay zones')
                                setReason(message)
                                setMessages((prev) => [
                                  ...prev,
                                  {
                                    id: createId('M'),
                                    role: 'assistant',
                                    text: message,
                                  },
                                ])
                              } catch (e) {
                                setError(
                                  e instanceof Error
                                    ? e.message
                                    : 'Stay zone failed',
                                )
                              } finally {
                                setBusy(false)
                              }
                            })()
                          }
                        >
                          Use as stay zone
                        </button>
                      </div>
                    ))
                  : null}
                {card.type === 'enrich'
                  ? card.caveats.map((c) => (
                      <p
                        key={c.topic}
                        className="trip-planner-card-in rounded-xl bg-amber-500/15 px-2.5 py-1.5 text-xs text-amber-100"
                      >
                        <strong>{c.topic}</strong>: {c.summary}
                      </p>
                    ))
                  : null}
                {card.type === 'knowhow' ? (
                  <div className="space-y-2">
                    {card.summary ? (
                      <p className="text-[11px] leading-snug text-violet-100/70">
                        {card.summary}
                      </p>
                    ) : null}
                    {card.areas.map((area, ai) => (
                      <div
                        key={`${area.areaLabel}-${ai}`}
                        className="trip-planner-card-in rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2"
                        style={{ animationDelay: `${ai * 70}ms` }}
                      >
                        <div className="text-sm font-semibold text-emerald-50">
                          {area.areaLabel}
                        </div>
                        <p className="mt-0.5 text-xs text-emerald-50/75">
                          {area.vibeFit}
                        </p>
                        {area.hotelZones.length ? (
                          <ul className="mt-1.5 space-y-1">
                            {area.hotelZones.map((z) => (
                              <li
                                key={z.label}
                                className="text-[11px] leading-snug text-emerald-100/85"
                              >
                                <span className="font-semibold text-emerald-50">
                                  {z.label}
                                </span>
                                {' — '}
                                {z.why}
                                {z.forVibes.length ? (
                                  <span className="text-emerald-200/45">
                                    {' '}
                                    · {z.forVibes.join(', ')}
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {area.tradeoffs ? (
                          <p className="mt-1.5 text-[11px] text-amber-100/80">
                            <span className="font-semibold">Tradeoff: </span>
                            {area.tradeoffs}
                          </p>
                        ) : null}
                        {area.readyTips.length ? (
                          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-emerald-100/70">
                            {area.readyTips.map((t, ti) => (
                              <li key={ti}>{t}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {error ? (
              <p className="trip-planner-bubble-in rounded-xl bg-rose-500/15 px-3 py-2 text-xs text-rose-200">
                {error}
              </p>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-white/5 p-2">
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={busy || applying}
                className="trip-planner-btn rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-violet-100/80 hover:bg-white/10 disabled:opacity-40"
                title="Clear chat and drafts; start again from the live Journey"
                onClick={restartConversation}
              >
                Restart chat
              </button>
              <button
                type="button"
                disabled={busy || applying}
                className="trip-planner-btn rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-100/90 hover:bg-emerald-500/20 disabled:opacity-40"
                title="Hotel-search neighborhoods and vibe tips per stay zone"
                onClick={() =>
                  void send(
                    'Give me area know-how for my stay zones: best neighborhoods to search hotels in, how each fits our vibe, tradeoffs, and practical tips so I feel ready to book.',
                  )
                }
              >
                Area know-how
              </button>
              <button
                type="button"
                disabled={!messages.length}
                className={`trip-planner-btn rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-violet-100/80 hover:bg-white/10 disabled:opacity-40 ${
                  chatCopyFlash
                    ? 'trip-planner-copy-flash border-emerald-400/40 text-emerald-200'
                    : ''
                }`}
                title="Copy the full conversation"
                onClick={() => void copyConversation()}
              >
                {chatCopyFlash ? 'Chat copied' : 'Copy chat'}
              </button>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void send(input)
              }}
            >
              <textarea
                className="min-h-[40px] max-h-[100px] flex-1 resize-none rounded-2xl border border-violet-400/25 bg-white/5 px-3 py-2 text-sm text-violet-50 placeholder:text-violet-200/35 outline-none transition-[box-shadow,border-color] duration-200 focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/40"
                placeholder="Vibe, region, flight times…"
                value={input}
                rows={1}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(input)
                  }
                }}
              />
              <button
                type="submit"
                disabled={busy || input.trim().length < 2}
                className="trip-planner-btn shrink-0 rounded-2xl bg-violet-600 px-3 py-2 text-sm font-semibold text-white shadow-md shadow-violet-950/40 disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </div>

        {/* Shape + versions column */}
        <div
          className={`flex min-h-0 flex-col ${phone ? 'min-h-0 flex-1' : 'w-[45%]'}`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/70">
                Shape · {versionLabel}
              </span>
              {sketchedLabel ? (
                <div className="truncate text-[10px] text-violet-200/45">
                  Sketched {sketchedLabel}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`trip-planner-btn rounded-lg border border-white/10 px-2 py-0.5 text-[10px] font-medium text-violet-100 disabled:opacity-30 ${
                  copyFlash ? 'trip-planner-copy-flash border-emerald-400/40 text-emerald-200' : ''
                }`}
                disabled={!draft && !trip.items.length}
                onClick={() => void copyStructure()}
                title="Copy trip structure"
              >
                {copyFlash ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="trip-planner-btn rounded-lg border border-white/10 px-2 py-0.5 text-xs text-violet-100 disabled:opacity-30"
                disabled={stack.index <= 0}
                onClick={() => scrub(-1)}
                title="Previous version"
              >
                ◀
              </button>
              <button
                type="button"
                className="trip-planner-btn rounded-lg border border-white/10 px-2 py-0.5 text-xs text-violet-100 disabled:opacity-30"
                disabled={
                  stack.index < 0 || stack.index >= stack.versions.length - 1
                }
                onClick={() => scrub(1)}
                title="Next version"
              >
                ▶
              </button>
            </div>
          </div>
          {stack.versions[stack.index] ? (
            <p className="shrink-0 px-3 py-1 text-[10px] text-violet-200/50">
              {stack.versions[stack.index]!.label}
              {stack.versions[stack.index]!.reason
                ? ` — ${stack.versions[stack.index]!.reason}`
                : ''}
            </p>
          ) : null}
          <div className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 ${TOUCH_SCROLL_Y}`}>
            <div className="trip-planner-shape-panel">
              <div
                key={activeVersion?.id || 'empty'}
                className={shapeAnimClass}
              >
                <TripShapeTree
                  trip={trip}
                  draft={draft}
                  onFocusArea={(area) => {
                    setInput(`Tell me more about stay zones in ${area}`)
                  }}
                  onFocusFlight={() => {
                    setInput(
                      'My flight departs __:__ from ___ and arrives __:__ at ___',
                    )
                  }}
                  onToggleHighlight={(h) => {
                    if (!draft) return
                    const dropped = new Set(
                      (draft.droppedHighlights || []).map((x) => x.toLowerCase()),
                    )
                    const key = h.toLowerCase()
                    if (dropped.has(key)) dropped.delete(key)
                    else dropped.add(key)
                    const next: FullTripDraft = {
                      ...draft,
                      droppedHighlights: [...dropped],
                    }
                    pushVersion(
                      next,
                      draft.spine.label,
                      modeLabel,
                      dropped.has(key) ? `Dropped “${h}”` : `Kept “${h}”`,
                    )
                  }}
                />
              </div>
            </div>
          </div>
          <div className="shrink-0 border-t border-white/5 p-3">
            <button
              type="button"
              disabled={!draft || applying}
              className={`trip-planner-btn w-full rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 disabled:opacity-40 ${
                applying ? 'trip-planner-apply-busy' : ''
              }`}
              onClick={() => void applySelected()}
            >
              {applying
                ? 'Building preview…'
                : draft
                  ? 'Preview on Journey'
                  : 'Sketch a route first'}
            </button>
            <p className="mt-1.5 text-center text-[10px] text-violet-300/40">
              Smart merge · purple = new/changed · grey = removed · Save or Discard
            </p>
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
