/**
 * Interactive trip-shape tree for Whole Trip draft preview.
 * Stay zones group nights; each calendar day stays visible (special dates ★).
 */

import type { TripRecord } from '../domain/types'
import { isPlaceholderBase } from '../data/dayBases'
import { groupDayPlan } from '../agent/groupDayPlan'
import type { FullTripDraft, FullTripHighlight } from '../agent/types'

type Props = {
  trip: TripRecord
  draft: FullTripDraft | null
  onFocusArea?: (areaLabel: string) => void
  onFocusFlight?: (itemId: string) => void
  onToggleHighlight?: (highlight: string) => void
}

function highlightName(h: FullTripHighlight | string): string {
  return typeof h === 'string' ? h : h.name
}

function highlightWhy(h: FullTripHighlight | string): string {
  return typeof h === 'string' ? '' : h.why
}

function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5) : iso
}

export function TripShapeTree({
  trip,
  draft,
  onFocusArea,
  onFocusFlight,
  onToggleHighlight,
}: Props) {
  const existing = trip.items.filter(
    (i) =>
      !isPlaceholderBase(i) &&
      ['flight', 'train', 'bus', 'ferry'].includes(i.type) &&
      i.status !== 'cancelled',
  )
  const dropped = new Set(
    (draft?.droppedHighlights || []).map((h) => h.toLowerCase()),
  )

  if (!draft && !existing.length) {
    return (
      <div className="rounded-2xl border border-dashed border-violet-400/25 bg-white/5 px-3 py-4 text-xs text-violet-200/55">
        Trip shape will appear here as we sketch — with a short why for each
        choice, so you can see we heard you.
      </div>
    )
  }

  const groups = draft ? groupDayPlan(draft) : []
  const decisions = draft?.decisions?.filter((d) => d.what && d.why) || []

  return (
    <div className="space-y-2 text-[11px] leading-snug text-violet-100/85">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/70">
        {draft?.spine.label || trip.meta.name || 'Trip shape'}
      </div>
      {draft?.spine.why ? (
        <p className="rounded-xl bg-violet-500/10 px-2.5 py-1.5 font-sans text-[11px] text-violet-100/75">
          <span className="font-semibold text-violet-200/90">Why this route: </span>
          {draft.spine.why}
        </p>
      ) : null}

      {existing.map((f) => (
        <button
          key={f.id}
          type="button"
          className="flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1 text-left font-mono transition-[background-color,transform] duration-150 hover:bg-violet-500/15 active:scale-[0.99]"
          onClick={() => onFocusFlight?.(f.id)}
        >
          <span className="text-violet-400/50">├─</span>
          <span>
            <span className="text-violet-200/50">{shortDate(f.date)}</span>{' '}
            <span className="font-sans font-medium text-sky-200">
              {f.type} {f.from && f.to ? `${f.from}→${f.to}` : f.title}
            </span>
            {f.start || f.end ? (
              <span className="text-violet-200/45">
                {' '}
                {f.start || '??'}–{f.end || '??'}
              </span>
            ) : (
              <span className="font-sans text-amber-200/60"> · add times?</span>
            )}
            <span className="mt-0.5 block font-sans text-[10px] text-violet-200/45">
              Already on your Journey — we build around this
            </span>
          </span>
        </button>
      ))}

      {groups.map((g) => {
        const multi = g.days.length > 1
        const showEachDay =
          multi ||
          g.days.some((d) => d.special) ||
          g.days.some((d) => d.theme.trim())
        return (
          <div key={`${g.areaLabel}-${g.start}`} className="space-y-0.5">
            <button
              type="button"
              className="flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1 text-left font-mono transition-[background-color,transform] duration-150 hover:bg-violet-500/15 active:scale-[0.99]"
              onClick={() => onFocusArea?.(g.areaLabel)}
            >
              <span className="text-violet-400/50">├─</span>
              <span className="font-sans">
                <span className="text-violet-200/50">
                  {shortDate(g.start)}
                  {g.end !== g.start ? `–${shortDate(g.end)}` : ''}
                </span>{' '}
                <strong className="font-semibold text-violet-50">
                  {g.areaLabel}
                </strong>
                <span className="text-violet-200/40"> stay-zone</span>
                {g.days.some((d) => d.special) ? (
                  <span className="ml-1 rounded bg-amber-400/20 px-1 py-px text-[9px] font-semibold text-amber-100">
                    ★ special day
                  </span>
                ) : null}
              </span>
            </button>

            {showEachDay
              ? g.days.map((day) => (
                  <div
                    key={day.date}
                    className={`ml-4 space-y-0.5 rounded-lg px-1.5 py-1 ${
                      day.special
                        ? 'bg-amber-400/10 ring-1 ring-amber-300/25'
                        : multi
                          ? 'bg-white/[0.03]'
                          : ''
                    }`}
                  >
                    <div className="font-sans text-[11px]">
                      {day.special ? (
                        <span className="mr-1 text-amber-200" aria-hidden>
                          ★
                        </span>
                      ) : (
                        <span className="mr-1 text-violet-400/40" aria-hidden>
                          │
                        </span>
                      )}
                      <span className="font-mono text-violet-200/55">
                        {shortDate(day.date)}
                      </span>
                      {day.theme ? (
                        <>
                          {' '}
                          <span
                            className={
                              day.special
                                ? 'font-semibold text-amber-50'
                                : 'text-violet-100/90'
                            }
                          >
                            {day.theme}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {day.why ? (
                      <div className="ml-4 font-sans text-[10px] text-violet-200/55">
                        Why: {day.why}
                      </div>
                    ) : null}
                    {day.highlights.map((h) => {
                      const name = highlightName(h)
                      const why = highlightWhy(h)
                      const droppedH = dropped.has(name.toLowerCase())
                      return (
                        <button
                          key={`${day.date}-${name}`}
                          type="button"
                          className={`ml-3 flex w-[calc(100%-0.75rem)] flex-col items-start gap-0.5 rounded px-1 py-0.5 text-left font-mono transition-[background-color,opacity,transform] duration-150 hover:bg-violet-500/10 active:scale-[0.99] ${
                            droppedH ? 'line-through opacity-40' : ''
                          }`}
                          onClick={() => onToggleHighlight?.(name)}
                          title={
                            droppedH ? 'Click to keep' : 'Click to drop before apply'
                          }
                        >
                          <span>
                            <span className="text-violet-400/40">└</span>{' '}
                            <span className="font-sans text-lime-100/80">
                              {name}
                            </span>
                          </span>
                          {why ? (
                            <span className="ml-3 font-sans text-[10px] text-violet-200/50 no-underline">
                              Why: {why}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ))
              : null}
          </div>
        )
      })}

      {decisions.length ? (
        <div className="mt-2 space-y-1.5 rounded-2xl border border-violet-400/20 bg-violet-500/10 px-2.5 py-2 font-sans">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
            Why we chose this
          </div>
          {decisions.map((d, i) => (
            <div key={`decision-${i}-${d.what.slice(0, 40)}`} className="text-[11px]">
              <div className="font-medium text-violet-50">{d.what}</div>
              <div className="text-violet-100/65">{d.why}</div>
            </div>
          ))}
        </div>
      ) : null}

      {draft?.planPlaceNames?.length ? (
        <div className="mt-1 space-y-1 font-sans text-[10px] text-violet-200/55">
          <div>
            +{draft.planPlaceNames.length} plan seed
            {draft.planPlaceNames.length === 1 ? '' : 's'}
          </div>
          {draft.planPlaceNames.slice(0, 4).map((p, i) =>
            p.why ? (
              <div key={`seed-${i}-${p.name}`} className="pl-1">
                <span className="text-violet-100/80">{p.name}</span> — {p.why}
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  )
}
