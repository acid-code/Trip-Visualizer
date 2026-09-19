type Props = {
  /** day = Day Coach; trip = Whole Trip merge */
  scope?: 'day' | 'trip'
  dayLabel: string
  /** Compact +N · ~N · −N line */
  summary?: string
  busy?: boolean
  error?: string | null
  onDiscard: () => void
  onSave: () => void
}

const DAY_TIP =
  'Day Coach is beta. Check that times, places, and drives look right before you Save — Discard undoes the draft.'
const TRIP_TIP =
  'Whole Trip merge is beta. Purple steps are new or changed; grey steps would be removed. Save commits the merge — Discard keeps your Journey as it was.'

/** Right-side Save / Discard rail while reviewing an AI patch. */
export function AiReviewChrome({
  scope = 'day',
  dayLabel,
  summary,
  busy,
  error,
  onDiscard,
  onSave,
}: Props) {
  const tip = scope === 'trip' ? TRIP_TIP : DAY_TIP
  return (
    <div className="pointer-events-none absolute inset-x-0 ai-review-chrome-offset top-auto z-[45] flex justify-end px-[max(0.5rem,env(safe-area-inset-right))] pb-1 sm:inset-y-0 sm:bottom-auto sm:right-0 sm:items-center sm:px-0 sm:pr-[max(0.5rem,env(safe-area-inset-right))]">
      <div
        className="pointer-events-auto flex w-[min(100%,11.5rem)] flex-row gap-2 rounded-2xl border border-stone-200/90 bg-white/95 p-2 shadow-[0_8px_28px_rgba(15,23,42,0.28)] backdrop-blur sm:w-[8.25rem] sm:flex-col"
        title={tip}
      >
        <div className="hidden flex-col gap-1 sm:flex">
          <div className="flex items-center justify-between gap-1 px-1 pt-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
              {scope === 'trip' ? 'Trip merge' : 'AI review'}
            </div>
            <span
              className="rounded bg-violet-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-800"
              title={tip}
            >
              Beta
            </span>
          </div>
          <p className="px-1 text-[11px] leading-snug text-stone-600">
            {scope === 'trip' ? (
              <>
                Preview of{' '}
                <span className="font-semibold text-stone-800">{dayLabel}</span>
                {summary ? (
                  <>
                    {' '}
                    <span className="font-mono text-[10px] text-violet-700">
                      ({summary})
                    </span>
                  </>
                ) : null}
                . Purple = new/changed, grey = removed.
              </>
            ) : (
              <>
                Browsing{' '}
                <span className="font-semibold text-stone-800">{dayLabel}</span> only.
                Make sure the edits fit, then Save — or Discard to revert.
              </>
            )}
          </p>
          {error ? (
            <p className="rounded-lg bg-rose-50 px-2 py-1.5 text-[10px] text-rose-700">
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          className="flex-1 rounded-xl bg-emerald-600 px-2 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 sm:flex-none sm:py-2"
          title={tip}
          onClick={onSave}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          className="flex-1 rounded-xl border border-stone-200 bg-stone-50 px-2 py-2.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50 sm:flex-none sm:py-2"
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </div>
  )
}
