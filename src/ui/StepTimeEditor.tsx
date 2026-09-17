import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { isValidTimeOrEmpty, sanitizeTime } from '../data/validate'

type Props = {
  open: boolean
  title: string
  start: string
  end: string
  onClose: () => void
  onSave: (start: string, end: string) => void
}

/** Compact start/end time editor — opened from a step’s time chip. */
export function StepTimeEditor({ open, title, start, end, onClose, onSave }: Props) {
  const [localStart, setLocalStart] = useState(start)
  const [localEnd, setLocalEnd] = useState(end)

  useEffect(() => {
    if (open) {
      setLocalStart(start)
      setLocalEnd(end)
    }
  }, [open, start, end])

  if (!open) return null

  const startOk = isValidTimeOrEmpty(localStart)
  const endOk = isValidTimeOrEmpty(localEnd)
  const canSave = startOk && endOk

  const dialog = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit step times"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[16.5rem] rounded-2xl border border-[var(--glass-border)] bg-[var(--paper-solid)] px-3 py-3 text-[var(--ink)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
          Times
        </p>
        <h3 className="mt-0.5 truncate text-sm font-semibold">{title}</h3>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-0.5 block text-[10px] font-medium text-[var(--ink-muted)]">
              Start
            </span>
            <input
              className={`w-full rounded-lg border bg-[var(--paper-2)] px-2 py-1.5 text-sm tabular-nums outline-none focus:border-[var(--coral)] ${
                startOk ? 'border-[var(--glass-border)]' : 'border-rose-400'
              }`}
              value={localStart}
              placeholder="HH:MM"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              aria-invalid={!startOk}
              onChange={(e) => setLocalStart(e.target.value)}
              onBlur={(e) => setLocalStart(sanitizeTime(e.target.value) || e.target.value.trim())}
            />
            {!startOk ? (
              <span className="mt-0.5 block text-[9px] text-rose-500">Use HH:MM</span>
            ) : null}
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[10px] font-medium text-[var(--ink-muted)]">
              End
            </span>
            <input
              className={`w-full rounded-lg border bg-[var(--paper-2)] px-2 py-1.5 text-sm tabular-nums outline-none focus:border-[var(--coral)] ${
                endOk ? 'border-[var(--glass-border)]' : 'border-rose-400'
              }`}
              value={localEnd}
              placeholder="HH:MM"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={!endOk}
              onChange={(e) => setLocalEnd(e.target.value)}
              onBlur={(e) => setLocalEnd(sanitizeTime(e.target.value) || e.target.value.trim())}
            />
            {!endOk ? (
              <span className="mt-0.5 block text-[9px] text-rose-500">Use HH:MM</span>
            ) : null}
          </label>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <button
            type="button"
            className="flex-1 rounded-full border border-[var(--glass-border)] px-3 py-1.5 text-xs text-[var(--ink-muted)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            className="flex-1 rounded-full bg-[var(--coral)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            onClick={() => {
              if (!canSave) return
              onSave(sanitizeTime(localStart), sanitizeTime(localEnd))
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
