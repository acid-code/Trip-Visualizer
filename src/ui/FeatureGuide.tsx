import { useEffect, useState } from 'react'
import type { FeatureTip, FeatureTipVisual } from '../data/featureGuide'

type Props = {
  tips: FeatureTip[]
  open: boolean
  onClose: () => void
  /** Called with tip ids the user finished viewing (current + earlier in this session). */
  onMarkSeen: (ids: string[]) => void
}

export function FeatureGuide({ tips, open, onClose, onMarkSeen }: Props) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (open) setIndex(0)
  }, [open, tips])

  if (!open || !tips.length) return null

  const tip = tips[Math.min(index, tips.length - 1)]!
  const isLast = index >= tips.length - 1
  const seenThrough = tips.slice(0, index + 1).map((t) => t.id)

  function finish(ids: string[]) {
    onMarkSeen(ids)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-guide-title"
    >
      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-white/15 bg-[#0f1a24] text-slate-100 shadow-2xl">
        <div className="relative aspect-[4/3] overflow-hidden bg-gradient-to-b from-[#1a2d3d] to-[#0c1520]">
          <TipFrame visual={tip.visual} />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0f1a24] to-transparent" />
        </div>

        <div className="flex flex-col gap-3 px-5 pb-5 pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-300/90">
              Tip {index + 1} of {tips.length}
            </p>
            <button
              type="button"
              className="text-xs text-white/50 hover:text-white/80"
              onClick={() => finish(tips.map((t) => t.id))}
            >
              Skip all
            </button>
          </div>

          <h2 id="feature-guide-title" className="text-xl font-semibold tracking-tight text-white">
            {tip.title}
          </h2>
          <p className="text-sm leading-relaxed text-white/75">{tip.body}</p>

          <div className="mt-1 flex items-center justify-center gap-1.5">
            {tips.map((t, i) => (
              <span
                key={t.id}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? 'w-5 bg-orange-400' : 'w-1.5 bg-white/25'
                }`}
              />
            ))}
          </div>

          <div className="mt-1 flex gap-2">
            {index > 0 ? (
              <button
                type="button"
                className="rounded-full border border-white/20 px-4 py-2.5 text-sm text-white/80 hover:bg-white/10"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              className="flex-1 rounded-full bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-orange-400"
              onClick={() => {
                if (isLast) finish(seenThrough)
                else {
                  onMarkSeen([tip.id])
                  setIndex((i) => i + 1)
                }
              }}
            >
              {isLast ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TipFrame({ visual }: { visual: FeatureTipVisual }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-5">
      <div className="relative h-full w-full max-w-[16rem] overflow-hidden rounded-2xl border border-white/20 bg-[#152536] shadow-inner">
        {/* Mini globe wash */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_60%_40%,#2a4a62_0%,#12202c_55%,#0a1218_100%)]" />
        <div className="absolute inset-x-[12%] top-[18%] bottom-[28%] rounded-full border border-sky-400/20 bg-sky-900/30" />

        {visual === 'long-press' ? (
          <>
            <Finger className="absolute left-[42%] top-[48%]" />
            <Pin className="absolute left-[48%] top-[38%]" color="#fb923c" pulse />
            <Caption>Hold · double-tap clears</Caption>
          </>
        ) : null}

        {visual === 'search' ? (
          <>
            <div className="absolute left-3 top-3 flex w-[70%] items-center gap-2 rounded-full border border-white/25 bg-black/50 px-2.5 py-1.5">
              <span className="text-[11px] text-white/80">⌕</span>
              <span className="truncate text-[10px] text-white/55">Nice, France</span>
            </div>
            <Pin className="absolute left-[55%] top-[45%]" color="#fb923c" />
          </>
        ) : null}

        {visual === 'tongues' ? (
          <>
            <div className="absolute bottom-3 left-2 top-3 w-[42%] rounded-xl border border-white/15 bg-stone-100/95 p-2">
              <div className="mb-1 h-2 w-10 rounded bg-stone-300" />
              <div className="space-y-1.5">
                <div className="h-6 rounded-lg bg-orange-100" />
                <div className="h-6 rounded-lg bg-stone-200" />
                <div className="h-6 rounded-lg bg-stone-200" />
              </div>
            </div>
            <div className="absolute right-0 top-[28%] flex flex-col gap-1">
              {['Steps', 'Stats', 'Data'].map((label, i) => (
                <div
                  key={label}
                  className={`rounded-l-lg px-2 py-1 text-[9px] font-semibold ${
                    i === 0 ? 'bg-orange-500 text-white' : 'bg-white/90 text-stone-700'
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {visual === 'pins-paths' ? (
          <>
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 160 120" fill="none">
              <path
                d="M28 88 C48 70, 70 55, 95 48 C115 42, 130 40, 142 36"
                stroke="#fbbf24"
                strokeWidth="3"
                strokeLinecap="round"
                opacity="0.85"
              />
              <circle cx="28" cy="88" r="5" fill="#38bdf8" />
              <circle cx="142" cy="36" r="5" fill="#fb923c" />
            </svg>
            <Caption>Tap a path</Caption>
          </>
        ) : null}

        {visual === 'walk' ? (
          <>
            <Pin className="absolute left-[48%] top-[40%]" color="#38bdf8" />
            <div className="absolute left-[42%] top-[58%] flex h-9 w-9 items-center justify-center rounded-full border border-white/30 bg-black/55 text-[10px] font-semibold text-sky-100 shadow">
              Walk
            </div>
          </>
        ) : null}

        {visual === 'explore' ? (
          <>
            <Pin className="absolute left-[48%] top-[40%]" color="#38bdf8" />
            <div className="absolute left-[58%] top-[56%] flex h-9 w-9 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500 text-sm font-bold text-white shadow">
              ★
            </div>
            <div className="absolute left-[22%] top-[30%] h-2.5 w-2.5 rounded-full bg-amber-400 shadow" />
            <div className="absolute left-[70%] top-[34%] h-2.5 w-2.5 rounded-full bg-amber-400 shadow" />
            <div className="absolute left-[34%] top-[62%] h-2.5 w-2.5 rounded-full bg-amber-400 shadow" />
          </>
        ) : null}

        {visual === 'plus-save' ? (
          <>
            <Pin className="absolute left-[48%] top-[42%]" color="#fb923c" />
            <div className="absolute bottom-4 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--coral,#f97316)] text-xl font-bold text-white shadow-lg">
              +
            </div>
          </>
        ) : null}

        {visual === 'overview' ? (
          <>
            <div className="absolute right-3 top-3 rounded-full border border-white/25 bg-black/45 px-2.5 py-1 text-[10px] text-white">
              Overview
            </div>
            <div className="absolute left-[20%] top-[35%] h-2 w-2 rounded-full bg-sky-400" />
            <div className="absolute left-[45%] top-[48%] h-2 w-2 rounded-full bg-orange-400" />
            <div className="absolute left-[65%] top-[30%] h-2 w-2 rounded-full bg-emerald-400" />
            <div className="absolute left-[55%] top-[62%] h-2 w-2 rounded-full bg-violet-400" />
          </>
        ) : null}

        {visual === 'drive' ? (
          <>
            <div className="absolute left-3 right-3 top-3 rounded-xl border border-emerald-400/40 bg-emerald-950/70 p-2.5 shadow">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                Google Drive
              </div>
              <div className="mt-1.5 space-y-1">
                <div className="flex items-center justify-between rounded-lg bg-white/10 px-2 py-1">
                  <span className="truncate text-[10px] text-white/90">france-south-loop.xlsx</span>
                  <span className="text-[9px] text-emerald-300">Load</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-white/10 px-2 py-1">
                  <span className="truncate text-[10px] text-white/90">my-trip-2.xlsx</span>
                  <span className="text-[9px] text-emerald-300">Load</span>
                </div>
              </div>
            </div>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-3 py-1 text-[10px] font-semibold text-white shadow">
              Save trip to Drive
            </div>
          </>
        ) : null}

        {visual === 'edit-trip' ? (
          <>
            <div className="absolute right-4 top-4 max-w-[11rem] rounded-2xl border border-orange-300/40 bg-black/50 px-3 py-2 text-right shadow-lg backdrop-blur">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-orange-300/90">
                Trip journal
              </div>
              <div className="mt-0.5 font-[family-name:Fraunces,Georgia,serif] text-base text-white underline decoration-white/40 underline-offset-2">
                Provence loop
              </div>
              <div className="text-[10px] text-white/65">Oct 1 → Oct 7</div>
              <div className="mt-1.5 inline-block rounded-full bg-orange-500/90 px-2 py-0.5 text-[9px] font-semibold text-white">
                Tap to edit
              </div>
            </div>
            <div className="absolute bottom-4 left-4 right-4 rounded-2xl border border-white/15 bg-[var(--paper)] p-3 text-[var(--ink)] shadow-xl">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--coral-deep)]">
                Trip details
              </div>
              <div className="mt-1 h-2 w-2/3 rounded bg-stone-200" />
              <div className="mt-2 flex gap-2">
                <div className="h-6 flex-1 rounded-lg bg-stone-100" />
                <div className="h-6 flex-1 rounded-lg bg-stone-100" />
              </div>
            </div>
          </>
        ) : null}

        {visual === 'new-trip' ? (
          <>
            <div className="absolute left-2 top-1/2 flex -translate-y-1/2 flex-col gap-1">
              {['Steps', 'Stats', 'Data'].map((label, i) => (
                <div
                  key={label}
                  className={`rounded-r-lg px-2 py-1.5 text-[9px] font-semibold ${
                    i === 2
                      ? 'bg-[var(--coral)] text-white shadow'
                      : 'bg-white/15 text-white/60'
                  }`}
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="absolute bottom-4 left-14 right-4 rounded-2xl border border-white/15 bg-[var(--paper)] p-3 text-[var(--ink)] shadow-xl">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                Data
              </div>
              <div className="mt-2 flex gap-2">
                <div className="rounded-full bg-[var(--coral)] px-3 py-1.5 text-[10px] font-semibold text-white">
                  New trip
                </div>
                <div className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-[10px] text-stone-500">
                  Open example
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-orange-200/80 bg-orange-50/80 px-2.5 py-2 text-[10px] text-stone-600">
                Name · start · end → day bases ready
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

function Pin({
  className,
  color,
  pulse,
}: {
  className?: string
  color: string
  pulse?: boolean
}) {
  return (
    <div className={className}>
      <div
        className={`h-3 w-3 rounded-full border-2 border-white shadow ${pulse ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: color }}
      />
    </div>
  )
}

function Finger({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <div className="relative">
        <div className="h-8 w-8 rounded-full border-2 border-white/70 bg-white/25" />
        <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-300" />
      </div>
    </div>
  )
}

function Caption({ children }: { children: string }) {
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[10px] text-white/85">
      {children}
    </div>
  )
}
