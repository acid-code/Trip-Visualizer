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
  onSelect: (id: string) => void
  onDayFilter: (day: string | null) => void
  onTypeFilter: (type: string | null) => void
  onInsertBetween: (afterId: string | null, beforeId: string | null) => void
  onAddDay?: () => void
  onDeleteStep?: (id: string) => void
}

export function TimelinePanel({
  meta,
  items,
  selectedId,
  dayFilter,
  typeFilter,
  onSelect,
  onDayFilter,
  onTypeFilter,
  onInsertBetween,
  onAddDay,
  onDeleteStep,
}: Props) {
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

  // If a map pick is hidden by filters, clear them so the step can appear
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

  // Scroll the Steps list so the selected card sits at the top (visible above Detail sheet)
  useEffect(() => {
    if (!selectedId) return
    const id = `step-card-${selectedId}`
    const run = () => {
      const root = listRef.current
      const el = root?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null
      if (!root || !el) return
      const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
      root.scrollTo({ top: Math.max(0, delta - 6), behavior: 'smooth' })
    }
    const t = window.setTimeout(run, 50)
    return () => window.clearTimeout(t)
  }, [selectedId, dayFilter, typeFilter, sorted.length])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-stone-800">
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

      <div
        ref={listRef}
        className="step-rail min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1"
      >
        <InsertButton
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
            <div key={item.id} id={`step-card-${item.id}`}>
              <div
                className={`relative w-full rounded-2xl border text-left transition ${
                  placeholder
                    ? active
                      ? 'border-dashed border-amber-400 bg-amber-50/90 shadow-sm'
                      : 'border-dashed border-amber-300/90 bg-amber-50/50'
                    : active
                      ? 'border-orange-300 bg-orange-50 shadow-sm'
                      : 'border-stone-200/80 bg-white/90'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setConfirmId(null)
                    onSelect(item.id)
                  }}
                  className="w-full px-3 py-3 text-left hover:border-orange-200"
                >
                  <span className="step-dot" style={{ color }} />
                  <div className="flex items-center justify-between gap-2 pl-1 pr-8">
                    <div className="flex items-center gap-1.5">
                      {ord ? (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                          style={{ background: color }}
                        >
                          {ord.day}.{ord.stepInDay}
                        </span>
                      ) : null}
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                        style={{ background: placeholder ? '#d97706' : TYPE_COLORS[item.type] }}
                      >
                        {placeholder ? 'base' : item.type}
                      </span>
                    </div>
                    <span className="text-xs text-stone-400">
                      {item.date.slice(5)}
                      {item.start && !placeholder ? ` · ${item.start}` : ''}
                    </span>
                  </div>
                  <div className="mt-1.5 pl-1 text-[15px] font-semibold tracking-tight text-stone-900">
                    {placeholder ? 'Add hotel / airport / station' : item.title}
                  </div>
                  <div className="pl-1 text-xs text-stone-500">
                    {placeholder
                      ? 'Every day starts with a sleep spot or arrival'
                      : [item.place, item.city, item.from && item.to ? `${item.from} → ${item.to}` : '']
                          .filter(Boolean)
                          .join(' · ')}
                  </div>
                  {!placeholder && item.notes ? (
                    <p className="mt-1 line-clamp-2 pl-1 text-xs text-stone-500">{item.notes}</p>
                  ) : null}
                </button>

                {onDeleteStep ? (
                  <div className="absolute right-2 top-2 z-10">
                    {confirming ? (
                      <div className="flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 p-0.5 shadow-sm">
                        <button
                          type="button"
                          className="rounded-full bg-rose-500 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-rose-600"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(null)
                            onDeleteStep(item.id)
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="rounded-full px-2 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-100"
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
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-rose-200/80 bg-rose-50 text-rose-500 shadow-sm transition hover:border-rose-300 hover:bg-rose-100 hover:text-rose-600"
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

              <InsertButton
                label={
                  next
                    ? `Add between · Day ${ord?.day ?? '?'}`
                    : 'Add at end'
                }
                onClick={() => onInsertBetween(item.id, next?.id ?? null)}
              />
            </div>
          )
        })}

        {!sorted.length && (
          <p className="text-sm text-stone-500">No steps yet — add the first one above.</p>
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

function InsertButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center justify-center gap-2 py-1.5 text-[11px] font-medium text-stone-400 transition hover:text-[var(--coral)]"
    >
      <span className="h-px flex-1 bg-stone-200 group-hover:bg-orange-200" />
      <span className="rounded-full border border-dashed border-stone-300 px-2.5 py-0.5 group-hover:border-orange-300 group-hover:bg-orange-50">
        + {label}
      </span>
      <span className="h-px flex-1 bg-stone-200 group-hover:bg-orange-200" />
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
