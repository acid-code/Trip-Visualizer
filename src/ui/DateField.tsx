import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isIsoDate } from '../data/validate'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** Approximate calendar panel size for flip / clamp math. */
const PANEL_W = 288
const PANEL_H = 312

function parseIso(iso: string): Date | null {
  if (!isIsoDate(iso)) return null
  const d = new Date(`${iso}T12:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

function toIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysInMonthGrid(view: Date): (string | null)[] {
  const first = new Date(view.getFullYear(), view.getMonth(), 1, 12)
  const startDow = (first.getDay() + 6) % 7 // Monday = 0
  const days: (string | null)[] = []
  for (let i = 0; i < startDow; i++) days.push(null)
  const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
  for (let d = 1; d <= count; d++) {
    days.push(toIso(new Date(view.getFullYear(), view.getMonth(), d, 12)))
  }
  while (days.length % 7 !== 0) days.push(null)
  return days
}

function formatDisplay(iso: string): string {
  const d = parseIso(iso)
  if (!d) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

type Props = {
  value: string
  onChange: (iso: string) => void
  min?: string
  max?: string
  required?: boolean
  disabled?: boolean
  className?: string
  id?: string
  placeholder?: string
  'aria-label'?: string
}

/**
 * Date control with a fixed-position calendar that flips above the field
 * when there isn’t enough room below (native type=date can’t do this).
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  required,
  disabled,
  className = '',
  id,
  placeholder = 'Pick a date',
  'aria-label': ariaLabel,
}: Props) {
  const autoId = useId()
  const fieldId = id || autoId
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{
    top: number
    left: number
  } | null>(null)

  const selected = parseIso(value)
  const [view, setView] = useState(() =>
    startMonth(selected || parseIso(min || '') || new Date()),
  )

  useEffect(() => {
    if (!open) return
    setView(startMonth(selected || parseIso(min || '') || new Date()))
  }, [open, value, min])

  useEffect(() => {
    if (!open || !btnRef.current) {
      setPos(null)
      return
    }
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom - 8
      const spaceAbove = r.top - 8
      const openUp = spaceBelow < PANEL_H && spaceAbove > spaceBelow
      const top = openUp
        ? Math.max(8, r.top - PANEL_H - 6)
        : Math.min(r.bottom + 6, window.innerHeight - PANEL_H - 8)
      const left = Math.min(
        Math.max(8, r.left),
        window.innerWidth - PANEL_W - 8,
      )
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDoc)
      document.addEventListener('keydown', onKey)
    }, 80)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const grid = useMemo(() => daysInMonthGrid(view), [view])
  const today = toIso(new Date())

  function pick(iso: string) {
    if (min && isIsoDate(min) && iso < min) return
    if (max && isIsoDate(max) && iso > max) return
    onChange(iso)
    setOpen(false)
  }

  function shiftMonth(delta: number) {
    setView(
      (v) => new Date(v.getFullYear(), v.getMonth() + delta, 1, 12),
    )
  }

  return (
    <>
      <button
        ref={btnRef}
        id={fieldId}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required || undefined}
        onClick={() => {
          if (disabled) return
          setOpen((v) => !v)
        }}
        className={`flex w-full items-center justify-between gap-2 text-left ${className}`}
      >
        <span
          className={
            selected ? 'tabular-nums text-inherit' : 'text-stone-400'
          }
        >
          {selected ? formatDisplay(value) : placeholder}
        </span>
        <span aria-hidden className="text-[10px] text-stone-400">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Choose date"
              className="fixed z-[220] rounded-2xl border border-stone-200 bg-white p-3 text-stone-800 shadow-2xl"
              style={{
                top: pos.top,
                left: pos.left,
                width: PANEL_W,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100"
                  aria-label="Previous month"
                  onClick={() => shiftMonth(-1)}
                >
                  ‹
                </button>
                <div className="text-sm font-semibold tabular-nums">
                  {MONTHS[view.getMonth()]} {view.getFullYear()}
                </div>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100"
                  aria-label="Next month"
                  onClick={() => shiftMonth(1)}
                >
                  ›
                </button>
              </div>

              <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[10px] font-medium text-stone-400">
                {WEEKDAYS.map((d) => (
                  <div key={d} className="py-1">
                    {d}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {grid.map((iso, idx) => {
                  if (!iso) {
                    return <div key={`e-${idx}`} className="h-9" />
                  }
                  const disabledDay =
                    (min && isIsoDate(min) && iso < min) ||
                    (max && isIsoDate(max) && iso > max)
                  const on = iso === value
                  const isToday = iso === today
                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={Boolean(disabledDay)}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (!disabledDay) pick(iso)
                      }}
                      className={`h-9 rounded-xl text-xs font-medium tabular-nums touch-manipulation transition ${
                        on
                          ? 'bg-[var(--coral)] text-white shadow-sm'
                          : disabledDay
                            ? 'cursor-not-allowed text-stone-300'
                            : isToday
                              ? 'bg-amber-50 text-amber-900 hover:bg-amber-100'
                              : 'text-stone-700 hover:bg-stone-100'
                      }`}
                    >
                      {Number(iso.slice(8, 10))}
                    </button>
                  )
                })}
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 border-t border-stone-100 pt-2">
                <button
                  type="button"
                  className="rounded-full px-2 py-1 text-[11px] font-medium text-stone-500 hover:bg-stone-50"
                  onClick={() => {
                    const t = toIso(new Date())
                    setView(startMonth(new Date()))
                    if (
                      !(min && isIsoDate(min) && t < min) &&
                      !(max && isIsoDate(max) && t > max)
                    ) {
                      pick(t)
                    }
                  }}
                >
                  Today
                </button>
                {!required && value ? (
                  <button
                    type="button"
                    className="rounded-full px-2 py-1 text-[11px] font-medium text-stone-500 hover:bg-stone-50"
                    onClick={() => {
                      onChange('')
                      setOpen(false)
                    }}
                  >
                    Clear
                  </button>
                ) : (
                  <span />
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function startMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12)
}
