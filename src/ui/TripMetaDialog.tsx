import { useEffect, useId, useMemo, useState } from 'react'
import type { TripMeta, TripRecord } from '../domain/types'
import {
  countTripDays,
  stepsOutsideRange,
  type RangeReconcileMode,
} from '../data/dayBases'
import { isIsoDate, sanitizeMetaDates } from '../data/validate'

export type TripMetaDraft = {
  name: string
  startDate: string
  endDate: string
}

type Props = {
  open: boolean
  mode: 'create' | 'edit'
  /** Seed values when opening (create defaults or active trip meta). */
  initial: TripMetaDraft
  /** Existing trip when editing — used for outside-range warnings. */
  trip?: TripRecord | null
  onClose: () => void
  onSubmit: (draft: TripMetaDraft, rangeMode: RangeReconcileMode) => void | Promise<void>
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function defaultCreateDraft(): TripMetaDraft {
  const start = todayIso()
  return { name: '', startDate: start, endDate: addDaysIso(start, 6) }
}

export function draftFromMeta(meta: TripMeta): TripMetaDraft {
  return {
    name: meta.name || '',
    startDate: isIsoDate(meta.startDate) ? meta.startDate : todayIso(),
    endDate: isIsoDate(meta.endDate) ? meta.endDate : todayIso(),
  }
}

export function TripMetaDialog({ open, mode, initial, trip, onClose, onSubmit }: Props) {
  const titleId = useId()
  const [name, setName] = useState(initial.name)
  const [startDate, setStartDate] = useState(initial.startDate)
  const [endDate, setEndDate] = useState(initial.endDate)
  const [rangeMode, setRangeMode] = useState<RangeReconcileMode>('keep-outside')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial.name)
    setStartDate(initial.startDate)
    setEndDate(initial.endDate)
    setRangeMode('keep-outside')
    setBusy(false)
    setError(null)
  }, [open, initial.name, initial.startDate, initial.endDate])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const dates = useMemo(() => {
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) return null
    return sanitizeMetaDates(startDate, endDate)
  }, [startDate, endDate])

  const dayCount = dates ? countTripDays(dates.startDate, dates.endDate) : 0

  const outside = useMemo(() => {
    if (mode !== 'edit' || !trip || !dates) return []
    return stepsOutsideRange(trip.items, dates.startDate, dates.endDate)
  }, [mode, trip, dates])

  const longTrip = dayCount > 90
  const hugeTrip = dayCount > 180

  if (!open) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!dates) {
      setError('Pick a valid start and end date.')
      return
    }
    if (hugeTrip) {
      setError('Trips can be at most about 6 months in the planner — shorten the range.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(
        {
          name: name.trim() || (mode === 'create' ? 'New trip' : 'Untitled trip'),
          startDate: dates.startDate,
          endDate: dates.endDate,
        },
        outside.length && rangeMode === 'drop-outside' ? 'drop-outside' : 'keep-outside',
      )
    } catch {
      setError('Could not save — try again.')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-[#e7e0d5] bg-[var(--paper)] text-[var(--ink)] shadow-2xl"
      >
        <div className="relative overflow-hidden px-5 pb-4 pt-5">
          <div
            className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full opacity-90"
            style={{
              background:
                'radial-gradient(circle at center, rgba(255,107,74,0.35), transparent 70%)',
            }}
          />
          <div
            className="pointer-events-none absolute -left-6 top-8 h-24 w-24 rounded-full opacity-80"
            style={{
              background:
                'radial-gradient(circle at center, rgba(13,148,136,0.22), transparent 70%)',
            }}
          />
          <p className="relative text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--coral-deep)]">
            {mode === 'create' ? 'New adventure' : 'Trip details'}
          </p>
          <h2 id={titleId} className="brand-mark relative mt-1 text-2xl text-[var(--ink)]">
            {mode === 'create' ? 'Name your trip' : 'Edit trip'}
          </h2>
          <p className="relative mt-1 text-sm text-[var(--ink-muted)]">
            {mode === 'create'
              ? 'We’ll set up a sleep/base spot for each day so the timeline is ready to fill.'
              : 'Update the name or dates — day bases adjust automatically.'}
          </p>
        </div>

        <div className="space-y-3 px-5 pb-2">
          <label className="block text-xs font-medium text-[var(--ink-muted)]">
            Trip name
            <input
              autoFocus
              className="mt-1 w-full rounded-2xl border border-[#e7e0d5] bg-white px-3 py-2.5 text-sm text-[var(--ink)] outline-none ring-[var(--coral)]/30 placeholder:text-stone-400 focus:ring-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Provence road trip"
              maxLength={200}
              disabled={busy}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-[var(--ink-muted)]">
              Start
              <input
                type="date"
                required
                className="mt-1 w-full rounded-2xl border border-[#e7e0d5] bg-white px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--coral)]/30"
                value={isIsoDate(startDate) ? startDate : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  setStartDate(v)
                  if (isIsoDate(endDate) && endDate < v) setEndDate(v)
                }}
                disabled={busy}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--ink-muted)]">
              End
              <input
                type="date"
                required
                className="mt-1 w-full rounded-2xl border border-[#e7e0d5] bg-white px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--coral)]/30"
                value={isIsoDate(endDate) ? endDate : ''}
                min={isIsoDate(startDate) ? startDate : undefined}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  setEndDate(v)
                }}
                disabled={busy}
              />
            </label>
          </div>

          {dayCount > 0 ? (
            <div className="rounded-2xl border border-teal-200/80 bg-teal-50/70 px-3 py-2 text-xs text-teal-900">
              <span className="font-semibold">
                {dayCount} day{dayCount === 1 ? '' : 's'}
              </span>
              {mode === 'create'
                ? ' — a base spot will be ready on each morning.'
                : ' in range — empty days get a base spot; extras outside tidy up.'}
              {longTrip && !hugeTrip ? (
                <span className="mt-1 block text-amber-800">
                  That’s a long stretch — still fine, just a lot of day cards.
                </span>
              ) : null}
            </div>
          ) : null}

          {outside.length > 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-950">
              <p className="font-semibold">
                {outside.length} step{outside.length === 1 ? '' : 's'} sit outside these dates
              </p>
              <p className="mt-1 text-amber-900/80">
                Choose what to do — we won’t surprise-delete without asking.
              </p>
              <div className="mt-2 space-y-1.5">
                <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-white/70 px-2 py-1.5">
                  <input
                    type="radio"
                    className="mt-0.5"
                    name="rangeMode"
                    checked={rangeMode === 'keep-outside'}
                    onChange={() => setRangeMode('keep-outside')}
                    disabled={busy}
                  />
                  <span>
                    <span className="font-medium">Keep them</span>
                    <span className="block text-amber-900/70">
                      Widen the trip dates so nothing is left behind.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-white/70 px-2 py-1.5">
                  <input
                    type="radio"
                    className="mt-0.5"
                    name="rangeMode"
                    checked={rangeMode === 'drop-outside'}
                    onChange={() => setRangeMode('drop-outside')}
                    disabled={busy}
                  />
                  <span>
                    <span className="font-medium">Remove them</span>
                    <span className="block text-amber-900/70">
                      Delete steps that fall fully outside the new window.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          ) : null}

          {trip?.isExample ? (
            <p className="text-[11px] text-[var(--ink-muted)]">
              You’re editing the sample trip on this device. Open Example again anytime to restore
              the original.
            </p>
          ) : null}

          {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
        </div>

        <div className="flex gap-2 px-5 pb-5 pt-3">
          <button
            type="button"
            className="flex-1 rounded-full border border-[#e7e0d5] bg-white px-4 py-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-stone-50 disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex-1 rounded-full bg-[var(--coral)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[var(--coral-deep)] disabled:opacity-50"
            disabled={busy || !dates || hugeTrip}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create trip' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
