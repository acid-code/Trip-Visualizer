import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TripItem, TripMeta } from '../domain/types'
import { TYPE_COLORS } from '../domain/types'
import { dayIndex, stepOrderMap } from '../data/analytics'
import { dayColor } from '../data/dayTheme'
import { sortItems } from '../data/db'
import { isPlaceholderBase } from '../data/dayBases'

type Props = {
  meta: TripMeta
  items: TripItem[]
  selectedId: string | null
  dayFilter: string | null
  typeFilter: string | null
  /** Highlight / focus a step (map pick or list highlight). */
  onSelect: (id: string) => void
  /** Open the detail sheet — list card tap. Defaults to onSelect when omitted. */
  onOpenDetail?: (id: string) => void
  onDayFilter: (day: string | null) => void
  onTypeFilter: (type: string | null) => void
  onInsertBetween: (afterId: string | null, beforeId: string | null) => void
  onAddDay?: () => void
  onDeleteStep?: (id: string) => void
  /** Desktop vertical rail vs phone Polarsteps-style horizontal strip. */
  layout?: 'vertical' | 'horizontal'
}

export function TimelinePanel({
  meta,
  items,
  selectedId,
  dayFilter,
  typeFilter,
  onSelect,
  onOpenDetail,
  onDayFilter,
  onTypeFilter,
  onInsertBetween,
  onAddDay,
  onDeleteStep,
  layout = 'vertical',
}: Props) {
  const horizontal = layout === 'horizontal'
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sorted = sortItems(items).filter((i) => {
    if (dayFilter && i.date !== dayFilter && i.endDate !== dayFilter) return false
    if (typeFilter && i.type !== typeFilter) return false
    return true
  })
  const days = [...new Set(items.map((i) => i.date).filter(Boolean))].sort()
  const types = [...new Set(items.map((i) => i.type))]
  const order = stepOrderMap(meta, items)

  useEffect(() => {
    if (!selectedId) return
    const item = items.find((i) => i.id === selectedId)
    if (!item) return
    if (dayFilter && item.date !== dayFilter && item.endDate !== dayFilter) {
      onDayFilter(null)
    }
    if (typeFilter && item.type !== typeFilter) {
      onTypeFilter(null)
    }
  }, [selectedId, items, dayFilter, typeFilter, onDayFilter, onTypeFilter])

  // Center the selected card when selection/filters change (no-op if already centered).
  // Closing Detail does not remount the strip, so it won't re-animate.
  useEffect(() => {
    if (!selectedId) return
    const id = `step-card-${selectedId}`
    const run = () => {
      const root = listRef.current
      const el = root?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null
      if (!root || !el) return
      scrollCardIntoView(root, el, horizontal)
    }
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(run)
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedId, dayFilter, typeFilter, horizontal])

  function openCard(id: string) {
    setConfirmId(null)
    // First tap: highlight / move to it. Second tap on the same card: open Detail.
    if (id !== selectedId) {
      onSelect(id)
      return
    }
    if (onOpenDetail) onOpenDetail(id)
    else onSelect(id)
  }

  return (
    <div
      className={`flex min-h-0 text-stone-800 ${
        horizontal ? 'flex-col gap-1.5' : 'h-full flex-col gap-2'
      }`}
    >
      {horizontal ? (
        <div className="flex items-center gap-2 px-0.5">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
            Day
            <select
              className="min-w-0 flex-1 truncate rounded-full border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium normal-case tracking-normal text-stone-700"
              value={dayFilter ?? ''}
              onChange={(e) => onDayFilter(e.target.value || null)}
            >
              <option value="">All</option>
              {days.map((d) => (
                <option key={d} value={d}>
                  Day {dayIndex(meta, d)} · {d.slice(5)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
            Type
            <select
              className="min-w-0 flex-1 truncate rounded-full border border-stone-200 bg-white px-2 py-1.5 text-xs font-medium normal-case tracking-normal capitalize text-stone-700"
              value={typeFilter ?? ''}
              onChange={(e) => onTypeFilter(e.target.value || null)}
            >
              <option value="">All</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {onAddDay ? (
            <button
              type="button"
              onClick={onAddDay}
              className="shrink-0 rounded-full border border-dashed border-stone-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-600"
            >
              + Day
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Chip active={dayFilter == null} onClick={() => onDayFilter(null)}>
              All days
            </Chip>
            {days.map((d) => {
              const n = dayIndex(meta, d)
              return (
                <Chip
                  key={d}
                  active={dayFilter === d}
                  onClick={() => onDayFilter(d)}
                  color={dayColor(meta, d)}
                >
                  Day {n}
                </Chip>
              )
            })}
            {onAddDay ? (
              <Chip active={false} onClick={onAddDay}>
                + Day
              </Chip>
            ) : null}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Chip active={typeFilter == null} tone="teal" onClick={() => onTypeFilter(null)}>
              Steps
            </Chip>
            {types.map((t) => (
              <Chip
                key={t}
                active={typeFilter === t}
                tone="teal"
                onClick={() => onTypeFilter(t)}
                accent={TYPE_COLORS[t]}
              >
                {t}
              </Chip>
            ))}
          </div>
        </>
      )}

      <div
        ref={listRef}
        className={
          horizontal
            ? 'step-rail-h flex snap-x snap-mandatory gap-1 overflow-x-auto overscroll-x-contain px-1 pb-1'
            : 'step-rail min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1'
        }
      >
        <InsertControl
          compact={horizontal}
          label="Add at start"
          onClick={() => onInsertBetween(null, sorted[0]?.id ?? null)}
        />

        {sorted.map((item, idx) => {
          const active = selectedId === item.id
          const ord = order.get(item.id)
          const color = dayColor(meta, item.date)
          const next = sorted[idx + 1]
          const placeholder = isPlaceholderBase(item)
          const confirming = confirmId === item.id
          return (
            <div
              key={item.id}
              id={`step-card-${item.id}`}
              className={
                horizontal
                  ? 'flex shrink-0 snap-center items-stretch gap-1'
                  : undefined
              }
            >
              <div
                className={`relative text-left transition ${
                  horizontal
                    ? `w-[9.75rem] rounded-2xl border ${
                        placeholder
                          ? active
                            ? 'border-dashed border-amber-400 bg-amber-50 shadow-sm'
                            : 'border-dashed border-amber-300 bg-amber-50/60'
                          : active
                            ? 'border-orange-400 bg-orange-50 shadow-md ring-2 ring-orange-300/60'
                            : 'border-stone-200/80 bg-white/95'
                      }`
                    : `w-full rounded-2xl border ${
                        placeholder
                          ? active
                            ? 'border-dashed border-amber-400 bg-amber-50/90 shadow-sm'
                            : 'border-dashed border-amber-300/90 bg-amber-50/50'
                          : active
                            ? 'border-orange-300 bg-orange-50 shadow-sm'
                            : 'border-stone-200/80 bg-white/90'
                      }`
                }`}
              >
                <button
                  type="button"
                  onClick={() => openCard(item.id)}
                  className={`w-full text-left ${horizontal ? 'px-2.5 py-2.5' : 'px-3 py-3'} hover:border-orange-200`}
                >
                  {!horizontal ? <span className="step-dot" style={{ color }} /> : null}
                  <div
                    className={`flex items-center justify-between gap-1 ${horizontal ? '' : 'pl-1 pr-8'}`}
                  >
                    <div className="flex min-w-0 items-center gap-1">
                      {ord ? (
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
                          style={{ background: color }}
                        >
                          {ord.day}.{ord.stepInDay}
                        </span>
                      ) : null}
                      <span
                        className="truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white"
                        style={{
                          background: placeholder ? '#d97706' : TYPE_COLORS[item.type],
                        }}
                      >
                        {placeholder ? 'base' : item.type}
                      </span>
                    </div>
                    {!horizontal ? (
                      <span className="text-xs text-stone-400">
                        {item.date.slice(5)}
                        {item.start && !placeholder ? ` · ${item.start}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={`mt-1 font-semibold tracking-tight text-stone-900 ${
                      horizontal
                        ? 'line-clamp-2 text-[13px] leading-snug'
                        : 'pl-1 text-[15px]'
                    }`}
                  >
                    {placeholder ? 'Add hotel / airport / station' : item.title}
                  </div>
                  {horizontal ? (
                    <div className="mt-0.5 text-[10px] text-stone-400">
                      {item.date.slice(5)}
                      {item.start && !placeholder ? ` · ${item.start}` : ''}
                    </div>
                  ) : (
                    <div className="pl-1 text-xs text-stone-500">
                      {placeholder
                        ? 'Every day starts with a sleep spot or arrival'
                        : [
                            item.place,
                            item.city,
                            item.from && item.to ? `${item.from} → ${item.to}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </div>
                  )}
                  {!horizontal && !placeholder && item.notes ? (
                    <p className="mt-1 line-clamp-2 pl-1 text-xs text-stone-500">{item.notes}</p>
                  ) : null}
                </button>

                {onDeleteStep ? (
                  <div
                    className={`absolute z-10 ${horizontal ? 'right-1 top-1' : 'right-2 top-2'}`}
                  >
                    {confirming ? (
                      <div className="flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 p-0.5 shadow-sm">
                        <button
                          type="button"
                          className="rounded-full bg-rose-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-rose-600"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(null)
                            onDeleteStep(item.id)
                          }}
                        >
                          Del
                        </button>
                        <button
                          type="button"
                          className="rounded-full px-1.5 py-1 text-[10px] font-medium text-rose-700"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(null)
                          }}
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        title="Delete step"
                        aria-label={`Delete ${item.title}`}
                        className={`flex items-center justify-center rounded-full border border-rose-200/80 bg-rose-50 text-rose-500 shadow-sm ${
                          horizontal ? 'h-6 w-6' : 'h-7 w-7'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmId(item.id)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                ) : null}
              </div>

              {next && next.date !== item.date ? (
                <DayPassageInsert
                  compact={horizontal}
                  fromDay={dayIndex(meta, item.date)}
                  toDay={dayIndex(meta, next.date)}
                  fromColor={dayColor(meta, item.date)}
                  toColor={dayColor(meta, next.date)}
                  onClick={() => onInsertBetween(item.id, next.id)}
                />
              ) : (
                <InsertControl
                  compact={horizontal}
                  label={
                    next
                      ? `Add between · Day ${ord?.day ?? '?'}`
                      : 'Add at end'
                  }
                  onClick={() => onInsertBetween(item.id, next?.id ?? null)}
                />
              )}
            </div>
          )
        })}

        {!sorted.length && (
          <p className="px-2 text-sm text-stone-500">No steps yet — tap + to add one.</p>
        )}
      </div>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 3h6m-9 4h12m-1.5 0-.7 12.1a2 2 0 0 1-2 1.9H9.2a2 2 0 0 1-2-1.9L6.5 7M10 11v6m4-6v6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Center the selected card in the strip (skip if already close enough). */
function scrollCardIntoView(
  root: HTMLElement,
  el: HTMLElement,
  horizontal: boolean,
) {
  const rootRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const slop = 10

  if (horizontal) {
    const delta =
      elRect.left + elRect.width / 2 - (rootRect.left + rootRect.width / 2)
    if (Math.abs(delta) < slop) return
    const max = Math.max(0, root.scrollWidth - root.clientWidth)
    const next = Math.max(0, Math.min(root.scrollLeft + delta, max))
    root.scrollTo({ left: next, behavior: 'smooth' })
    return
  }

  const delta =
    elRect.top + elRect.height / 2 - (rootRect.top + rootRect.height / 2)
  if (Math.abs(delta) < slop) return
  const max = Math.max(0, root.scrollHeight - root.clientHeight)
  const next = Math.max(0, Math.min(root.scrollTop + delta, max))
  root.scrollTo({ top: next, behavior: 'smooth' })
}

function DayPassageInsert({
  fromDay,
  toDay,
  fromColor,
  toColor,
  onClick,
  compact,
}: {
  fromDay: number
  toDay: number
  fromColor: string
  toColor: string
  onClick: () => void
  compact?: boolean
}) {
  if (compact) {
    return (
      <div
        className="relative mx-0.5 flex w-[3.4rem] shrink-0 flex-col items-center justify-center self-stretch"
        title={`Day ${fromDay} → Day ${toDay}`}
      >
        {/* Vertical dotted day-change line */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-1/2 z-0 w-0 -translate-x-1/2 border-l-2 border-dotted border-stone-300"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 z-0 -translate-y-1/2 select-none text-[12px] font-bold tabular-nums opacity-40"
          style={{ color: fromColor }}
        >
          {fromDay}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-1/2 z-0 -translate-y-1/2 select-none text-[12px] font-bold tabular-nums opacity-40"
          style={{ color: toColor }}
        >
          {toDay}
        </span>
        <button
          type="button"
          onClick={onClick}
          aria-label={`Add between Day ${fromDay} and Day ${toDay}`}
          className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-stone-300 bg-white/95 text-lg font-semibold leading-none text-stone-400 shadow-sm hover:border-orange-300 hover:bg-orange-50 hover:text-[var(--coral)]"
        >
          +
        </button>
      </div>
    )
  }

  return (
    <div
      className="relative flex w-full items-center gap-2 py-1.5"
      title={`Day ${fromDay} → Day ${toDay}`}
    >
      <span
        className="select-none text-[11px] font-bold tabular-nums opacity-45"
        style={{ color: fromColor }}
      >
        {fromDay}
      </span>
      <div
        aria-hidden
        className="h-0 flex-1 border-t-2 border-dotted border-stone-300"
      />
      <button
        type="button"
        onClick={onClick}
        aria-label={`Add between Day ${fromDay} and Day ${toDay}`}
        className="relative z-[1] flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-stone-300 bg-white text-base font-semibold leading-none text-stone-400 hover:border-orange-300 hover:bg-orange-50 hover:text-[var(--coral)]"
      >
        +
      </button>
      <div
        aria-hidden
        className="h-0 flex-1 border-t-2 border-dotted border-stone-300"
      />
      <span
        className="select-none text-[11px] font-bold tabular-nums opacity-45"
        style={{ color: toColor }}
      >
        {toDay}
      </span>
    </div>
  )
}

function InsertControl({
  label,
  onClick,
  compact,
}: {
  label: string
  onClick: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={
        compact
          ? 'my-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-stone-300 bg-white text-lg font-semibold leading-none text-stone-400 shadow-sm hover:border-orange-300 hover:bg-orange-50 hover:text-[var(--coral)]'
          : 'mx-auto flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-stone-300 bg-white text-base font-semibold leading-none text-stone-400 transition hover:border-orange-300 hover:bg-orange-50 hover:text-[var(--coral)]'
      }
    >
      +
    </button>
  )
}

function Chip({
  children,
  active,
  onClick,
  tone = 'coral',
  accent,
  color,
}: {
  children: ReactNode
  active: boolean
  onClick: () => void
  tone?: 'coral' | 'teal'
  accent?: string
  color?: string
}) {
  const on = color
    ? 'text-white'
    : tone === 'coral'
      ? 'bg-[var(--coral)] text-white'
      : 'bg-teal-600 text-white'
  const off = 'bg-white text-stone-600 border border-stone-200'
  return (
    <button
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium capitalize ${active ? on : off}`}
      onClick={onClick}
      style={{
        ...(active && color ? { background: color } : undefined),
        ...(!active && accent ? { boxShadow: `inset 3px 0 0 ${accent}` } : undefined),
      }}
    >
      {children}
    </button>
  )
}
