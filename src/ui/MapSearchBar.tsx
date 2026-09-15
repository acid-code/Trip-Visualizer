import type { ReactNode } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  busy?: boolean
  onSearch: (query: string) => void
  onClear?: () => void
  /** Hint line under the search control (pin / long-press help). */
  hint?: ReactNode
  /** Emphasized (pin) vs quiet (idle) hint styling. */
  hintTone?: 'quiet' | 'pin'
  /** When true, render via portal so Cesium / header cannot steal taps. */
  portal?: boolean
}

/** Compact map search that expands on focus / tap. */
export function MapSearchBar({
  busy,
  onSearch,
  onClear,
  hint,
  hintTone = 'quiet',
  portal = true,
}: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = q.trim()
    if (!trimmed) return
    onSearch(trimmed)
  }

  function openBar(e: React.SyntheticEvent) {
    e.preventDefault()
    e.stopPropagation()
    setOpen(true)
  }

  function closeBar() {
    setOpen(false)
    setQ('')
    onClear?.()
  }

  const ui = (
    <div className="flex flex-col items-start gap-1">
      {!open ? (
        <button
          type="button"
          className="flex h-9 w-9 touch-manipulation items-center justify-center rounded-full border border-white/30 bg-black/55 text-white shadow-lg backdrop-blur hover:bg-black/65"
          title="Search place or address"
          aria-label="Search place or address"
          onPointerDown={openBar}
          onClick={openBar}
        >
          <span className="text-sm" aria-hidden>
            🔍
          </span>
        </button>
      ) : (
        <form
          className="flex w-[min(11.25rem,calc(100vw-8.75rem))] touch-manipulation items-center gap-0.5 rounded-full border border-white/30 bg-black/65 p-0.5 pl-2 shadow-lg backdrop-blur"
          onSubmit={submit}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/45"
            placeholder="Search…"
            value={q}
            disabled={busy}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !q.trim()}
            className="shrink-0 rounded-full bg-orange-500 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? '…' : 'Go'}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs text-white/80 hover:bg-white/10 hover:text-white"
            onClick={closeBar}
            title="Close search"
            aria-label="Close search"
          >
            ✕
          </button>
        </form>
      )}
      {hint ? (
        <p
          className={
            hintTone === 'pin'
              ? 'pointer-events-none max-w-[9.5rem] rounded-lg bg-black/45 px-2 py-1 text-[10px] leading-snug text-orange-100 backdrop-blur'
              : 'pointer-events-none max-w-[8.5rem] text-[10px] leading-snug text-white/55 drop-shadow'
          }
        >
          {hint}
        </p>
      ) : null}
    </div>
  )

  if (!portal || typeof document === 'undefined') return ui

  return createPortal(
    <div
      className={`pointer-events-none fixed left-3 top-[max(0.75rem,env(safe-area-inset-top))] ${
        open ? 'z-[55]' : 'z-[38]'
      }`}
      data-coach="map-search"
    >
      <div className="pointer-events-auto">{ui}</div>
    </div>,
    document.body,
  )
}
