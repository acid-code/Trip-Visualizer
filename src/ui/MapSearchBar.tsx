import { useState } from 'react'

type Props = {
  busy?: boolean
  onSearch: (query: string) => void
  onClear?: () => void
}

/** Compact map search that expands on focus / tap. */
export function MapSearchBar({ busy, onSearch, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = q.trim()
    if (!trimmed) return
    onSearch(trimmed)
  }

  if (!open) {
    return (
      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/25 bg-black/45 text-white shadow-lg backdrop-blur hover:bg-black/55"
        title="Search place or address"
        onClick={() => setOpen(true)}
      >
        <span className="text-sm" aria-hidden>
          🔍
        </span>
      </button>
    )
  }

  return (
    <form
      className="flex max-w-[min(18rem,72vw)] items-center gap-1 rounded-full border border-white/25 bg-black/55 p-1 pl-3 shadow-lg backdrop-blur"
      onSubmit={submit}
    >
      <input
        autoFocus
        className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/50"
        placeholder="Place, address, or Maps link…"
        value={q}
        disabled={busy}
        onChange={(e) => setQ(e.target.value)}
      />
      <button
        type="submit"
        disabled={busy || !q.trim()}
        className="rounded-full bg-orange-500 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy ? '…' : 'Go'}
      </button>
      <button
        type="button"
        className="rounded-full px-2 py-1 text-xs text-white/70 hover:text-white"
        onClick={() => {
          setOpen(false)
          setQ('')
          onClear?.()
        }}
        title="Close search"
      >
        ✕
      </button>
    </form>
  )
}
