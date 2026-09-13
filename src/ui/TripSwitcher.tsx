import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TripRecord } from '../domain/types'

type Props = {
  trips: TripRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void | Promise<void>
  /** Close side panels / tongues before the confirm dialog shows. */
  onPrepareDelete?: () => void
  /** Open the create-trip dialog. */
  onCreate: () => void
}

export function TripSwitcher({ trips, activeId, onSelect, onDelete, onPrepareDelete, onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const active = trips.find((t) => t.id === activeId) ?? null
  const pending = confirmId ? trips.find((t) => t.id === confirmId) : null

  useEffect(() => {
    if (!open || confirmId) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, confirmId])

  useEffect(() => {
    if (!confirmId) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        e.stopPropagation()
        setConfirmId(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey, true)
    }
  }, [confirmId, busy])

  function requestDelete(id: string) {
    onPrepareDelete?.()
    setOpen(false)
    setConfirmId(id)
  }

  async function confirmDelete() {
    if (!confirmId) return
    setBusy(true)
    try {
      await onDelete(confirmId)
      setConfirmId(null)
    } finally {
      setBusy(false)
    }
  }

  const confirmModal =
    pending && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trip-delete-title"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full max-w-sm overflow-hidden rounded-3xl border border-[#e7e0d5] bg-[var(--paper)] text-[var(--ink)] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
              <div className="flex items-start gap-3 px-5 pt-5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-100 text-red-600">
                  <TrashIcon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-600/80">
                    Delete trip
                  </p>
                  <h2 id="trip-delete-title" className="brand-mark mt-1 text-xl leading-snug">
                    Remove “{pending.meta.name}”?
                  </h2>
                </div>
              </div>
              <p className="mt-3 px-5 text-sm text-[var(--ink-muted)]">
                {pending.isExample
                  ? 'This only hides the sample here. You can open it again anytime from Data.'
                  : 'This removes the trip from this device. A Google Drive copy is not deleted automatically — remove it in Drive if you want that gone too.'}
              </p>
              <div className="flex gap-2 px-5 py-5">
                <button
                  type="button"
                  className="flex-1 rounded-full border border-[#e7e0d5] bg-white px-4 py-3 text-sm font-medium text-[var(--ink-muted)] hover:bg-stone-50 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setConfirmId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-full bg-red-600 px-4 py-3 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-[12rem]">
      <button
        type="button"
        className="flex w-full max-w-full items-center gap-1.5 rounded-full border border-white/20 bg-black/45 py-1.5 pl-3 pr-2 text-left text-xs text-white shadow-sm backdrop-blur hover:bg-black/55"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((v) => !v)
          setConfirmId(null)
        }}
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {active ? (
            <>
              {active.isExample ? <span className="mr-1 text-orange-300">★</span> : null}
              {active.meta.name}
            </>
          ) : (
            <span className="text-white/60">No trip</span>
          )}
        </span>
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-white/70 transition ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open ? (
        <div
          id={listId}
          className="absolute right-0 z-50 mt-1.5 w-[min(12rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.25rem)] text-white"
          role="listbox"
        >
          <div className="overflow-hidden rounded-t-2xl border border-b-0 border-white/15 bg-[#0f1a24]/95 shadow-2xl backdrop-blur-md">
            <div className="border-b border-white/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-orange-300/90">
              Your trips
            </div>
            <ul className="max-h-64 overflow-y-auto py-1">
              {trips.length === 0 ? (
                <li className="px-3 py-3 text-xs text-white/50">No trips yet — tap + to start one.</li>
              ) : (
                trips.map((t) => {
                  const selected = t.id === activeId
                  return (
                    <li
                      key={t.id}
                      className={`group flex items-center gap-1 px-1.5 ${
                        selected ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="min-w-0 flex-1 rounded-xl px-2.5 py-2.5 text-left"
                        onClick={() => {
                          onSelect(t.id)
                          setOpen(false)
                        }}
                      >
                        <div className="truncate text-sm font-medium">
                          {t.isExample ? <span className="mr-1 text-orange-300">★</span> : null}
                          {t.meta.name}
                        </div>
                        <div className="truncate text-[10px] text-white/50">
                          {t.meta.startDate} → {t.meta.endDate}
                          {t.isExample ? ' · sample' : ''}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/55 transition hover:border-red-400/40 hover:bg-red-500/25 hover:text-red-200"
                        title={t.isExample ? 'Remove sample from list' : 'Delete trip'}
                        aria-label={`Delete ${t.meta.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          requestDelete(t.id)
                        }}
                      >
                        <TrashIcon className="h-5 w-5" />
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
          <button
            type="button"
            className="flex h-9 w-full items-start justify-center bg-[var(--coral)] pt-1.5 text-white shadow-[0_8px_20px_rgba(0,0,0,0.3)] transition hover:bg-[var(--coral-deep)]"
            style={{ borderRadius: '0 0 50% 50% / 0 0 100% 100%' }}
            title="New trip"
            aria-label="Add new trip"
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
          >
            <PlusIcon className="h-5 w-5" />
          </button>
        </div>
      ) : null}

      {confirmModal}
    </div>
  )
}

function PlusIcon({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function TrashIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6.75h18" />
      <path d="M8.5 6.75V5.2A1.7 1.7 0 0 1 10.2 3.5h3.6a1.7 1.7 0 0 1 1.7 1.7v1.55" />
      <path d="M6.4 6.75 7.2 19.1A1.8 1.8 0 0 0 9 20.75h6a1.8 1.8 0 0 0 1.8-1.65l.8-12.35" />
      <path d="M10 10.5v6.25M14 10.5v6.25" />
    </svg>
  )
}
