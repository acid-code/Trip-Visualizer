type Props = {
  dayLabel: string
  busy?: boolean
  error?: string | null
  onDiscard: () => void
  onSave: () => void
}

const REVIEW_TIP =
  'Day Coach is beta. Check that times, places, and drives look right before you Save — Discard undoes the draft.'

/** Right-side Save / Discard rail while reviewing an AI day patch. */
export function AiReviewChrome({
  dayLabel,
  busy,
  error,
  onDiscard,
  onSave,
}: Props) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-[45] flex items-center pr-[max(0.5rem,env(safe-area-inset-right))]">
      <div
        className="pointer-events-auto flex w-[7.5rem] flex-col gap-2 rounded-2xl border border-stone-200/90 bg-white/95 p-2 shadow-[0_8px_28px_rgba(15,23,42,0.28)] backdrop-blur"
        title={REVIEW_TIP}
      >
        <div className="flex items-center justify-between gap-1 px-1 pt-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
            AI review
          </div>
          <span
            className="rounded bg-violet-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-800"
            title={REVIEW_TIP}
          >
            Beta
          </span>
        </div>
        <p className="px-1 text-[11px] leading-snug text-stone-600">
          Browsing <span className="font-semibold text-stone-800">{dayLabel}</span> only.
          Make sure the edits fit, then Save — or Discard to revert.
        </p>
        {error ? (
          <p className="rounded-lg bg-rose-50 px-2 py-1.5 text-[10px] text-rose-700">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          className="rounded-xl bg-emerald-600 px-2 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          title={REVIEW_TIP}
          onClick={onSave}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded-xl border border-stone-200 bg-stone-50 px-2 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  )
}
