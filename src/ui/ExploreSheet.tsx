import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  exploreCategoryLabel,
  filterAndSortExplore,
  type ExploreCategory,
  type ExplorePlace,
  type ExploreSort,
} from '../data/explore'
import {
  mapsNearbyExploreUrl,
  mapsPlaceSearchUrl,
  openExternalUrl,
} from '../data/mapsLinks'

type Props = {
  open: boolean
  busy: boolean
  error?: string | null
  places: ExplorePlace[]
  selectedId: string | null
  detail: ExplorePlace | null
  /** Anchor for the Google Maps pin deep link */
  anchor?: { lat: number; lon: number; label?: string } | null
  onClose: () => void
  onSelect: (place: ExplorePlace) => void
  onCloseDetail: () => void
  onAddStep: (place: ExplorePlace) => void
  phone?: boolean
}

/** One category at a time — full nearby result stays cached; this only filters UI. */
const CATEGORY_CHIPS: Array<{
  id: ExploreCategory
  short: string
  tone: string
  toneActive: string
}> = [
  {
    id: 'food',
    short: 'Food',
    tone: 'border-orange-500/35 bg-orange-500/10 text-[var(--ink)]',
    toneActive: 'border-orange-400 bg-orange-500 text-white shadow-sm',
  },
  {
    id: 'drink',
    short: 'Drinks',
    tone: 'border-violet-500/35 bg-violet-500/10 text-[var(--ink)]',
    toneActive: 'border-violet-400 bg-violet-500 text-white shadow-sm',
  },
  {
    id: 'sights',
    short: 'Sights',
    tone: 'border-sky-500/35 bg-sky-500/10 text-[var(--ink)]',
    toneActive: 'border-sky-400 bg-sky-500 text-white shadow-sm',
  },
  {
    id: 'hotel',
    short: 'Hotels',
    tone: 'border-teal-500/35 bg-teal-500/10 text-[var(--ink)]',
    toneActive: 'border-teal-400 bg-teal-600 text-white shadow-sm',
  },
  {
    id: 'nature',
    short: 'Nature',
    tone: 'border-lime-500/35 bg-lime-500/10 text-[var(--ink)]',
    toneActive: 'border-lime-500 bg-lime-600 text-white shadow-sm',
  },
]

const SORT_OPTIONS: Array<{ id: ExploreSort; label: string }> = [
  { id: 'distance', label: 'Near' },
  { id: 'rating', label: 'Rated' },
  { id: 'name', label: 'A–Z' },
]

export function ExploreSheet({
  open,
  busy,
  error,
  places,
  selectedId,
  detail,
  anchor = null,
  onClose,
  onSelect,
  onCloseDetail,
  onAddStep,
}: Props) {
  const [typeFilter, setTypeFilter] = useState<ExploreCategory>('food')
  const [sort, setSort] = useState<ExploreSort>('distance')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const scrollLeftRef = useRef(0)

  const filtered = useMemo(
    () => filterAndSortExplore(places, typeFilter, sort),
    [places, typeFilter, sort],
  )

  const counts = useMemo(() => {
    const map: Partial<Record<ExploreCategory, number>> = {}
    for (const p of places) {
      map[p.category] = (map[p.category] ?? 0) + 1
    }
    return map
  }, [places])

  useEffect(() => {
    scrollLeftRef.current = 0
    const el = scrollerRef.current
    if (el) el.scrollLeft = 0
  }, [typeFilter, sort])

  // Keep horizontal position when the list refreshes in the background.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollLeft = scrollLeftRef.current
  }, [filtered])

  if (!open) return null

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--paper)] text-[var(--ink)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">
              Nearby
            </div>
            <h2 className="text-base font-semibold text-[var(--ink)]">Explore</h2>
          </div>
          {anchor && isValidAnchor(anchor) ? (
            <button
              type="button"
              className="rounded-full bg-[#1a73e8] px-2.5 py-1 text-[10px] font-semibold tracking-wide text-white shadow-sm hover:bg-[#1557b0]"
              title="Open this area in Google Maps"
              onClick={() =>
                openExternalUrl(mapsNearbyExploreUrl(anchor, anchor.label))
              }
            >
              Google
            </button>
          ) : null}
        </div>

        <div className="mx-auto inline-flex shrink-0 rounded-lg border border-[var(--glass-border)] bg-[var(--paper-2)] p-px shadow-sm">
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold tracking-wide transition-colors duration-150 ${
                  active
                    ? 'bg-[var(--ink)] text-[var(--paper-solid)]'
                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                }`}
                onClick={() => setSort(opt.id)}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="shrink-0 rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-1 text-xs text-[var(--ink-muted)] shadow-sm"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CATEGORY_CHIPS.map((chip) => {
            const active = typeFilter === chip.id
            const n = counts[chip.id] ?? 0
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                className={`shrink-0 rounded-2xl border px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-[transform,background-color,box-shadow,border-color] duration-150 active:scale-[0.97] ${
                  active ? chip.toneActive : chip.tone
                }`}
                onClick={() => setTypeFilter(chip.id)}
              >
                {chip.short}
                {places.length ? (
                  <span
                    className={`ml-1.5 tabular-nums ${
                      active ? 'text-white/80' : 'opacity-60'
                    }`}
                  >
                    {n}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-[var(--ink-muted)]">
          {busy ? 'Loading…' : filtered.length}
        </span>
      </div>

      <div
        className="min-h-0 flex-1 overflow-hidden px-3 py-2"
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {error ? (
          <p className="mb-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-[color-mix(in_srgb,#e11d48_85%,var(--ink))]">
            {error}
          </p>
        ) : null}
        {busy && !places.length ? (
          <p className="py-6 text-center text-sm text-[var(--ink-muted)]">Looking around…</p>
        ) : null}
        {!busy && !filtered.length && !error ? (
          <p className="py-6 text-center text-sm text-[var(--ink-muted)]">
            No {exploreCategoryLabel(typeFilter).toLowerCase()} nearby — try another category.
          </p>
        ) : null}

        <div
          ref={scrollerRef}
          className="flex h-full gap-2.5 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x [-webkit-overflow-scrolling:touch] pb-1 pt-1 [scrollbar-width:thin]"
          onScroll={(e) => {
            scrollLeftRef.current = e.currentTarget.scrollLeft
          }}
        >
          {filtered.map((place) => (
            <ExploreCard
              key={place.id}
              place={place}
              selected={place.id === selectedId}
              onSelect={() => onSelect(place)}
            />
          ))}
        </div>
      </div>

      {detail ? (
        <div className="absolute inset-0 z-20 flex flex-col bg-[color-mix(in_srgb,var(--bg)_45%,transparent)] backdrop-blur-[2px]">
          <div className="mt-auto max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain touch-pan-y rounded-t-3xl border border-[var(--glass-border)] bg-[var(--paper-solid)] text-[var(--ink)] shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--glass-border)] bg-[var(--paper)] px-4 py-2.5 backdrop-blur">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--teal)]">
                  {exploreCategoryLabel(detail.category)}
                </div>
                <h3 className="truncate text-sm font-semibold text-[var(--ink)]">{detail.name}</h3>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] text-[var(--ink-muted)]"
                title="Back to explore list"
                onClick={onCloseDetail}
              >
                ✕
              </button>
            </div>
            <div className="space-y-2.5 px-4 py-3">
              <DetailMedia place={detail} />

              {detail.images.length !== 1 ? (
                <DetailMeta place={detail} />
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] shadow-sm"
                  onClick={() => {
                    const mapsUri = detail.tags.googleMapsUri
                    openExternalUrl(
                      mapsUri ||
                        mapsPlaceSearchUrl(detail.name, detail, {
                          address: detail.address,
                          category: detail.category,
                          cuisine: detail.cuisine,
                        }),
                    )
                  }}
                >
                  Google Maps · reviews
                </button>
                {detail.menuUrl &&
                (detail.category === 'food' || detail.category === 'drink') ? (
                  <button
                    type="button"
                    className="rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-[color-mix(in_srgb,#b45309_70%,var(--ink))] shadow-sm"
                    onClick={() => openExternalUrl(detail.menuUrl)}
                  >
                    Menu
                  </button>
                ) : null}
                {detail.website ? (
                  <button
                    type="button"
                    className="rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-1.5 text-xs font-medium text-[var(--sky)] shadow-sm"
                    onClick={() => openExternalUrl(detail.website)}
                  >
                    Website
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                className="w-full rounded-2xl bg-[var(--coral)] py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95"
                onClick={() => onAddStep(detail)}
              >
                Add step
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Fixed-height photo strip: fit full image height; extra photos fill width, else info sits beside. */
function DetailMedia({ place }: { place: ExplorePlace }) {
  const images = place.images.filter(Boolean)
  const single = images.length <= 1

  if (!images.length) {
    return (
      <div className="flex h-24 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--coral)_18%,var(--paper-2))] text-2xl">
        📍
      </div>
    )
  }

  return (
    <div className={`flex gap-3 ${single ? 'items-stretch' : 'flex-col'}`}>
      <div
        className={`flex h-36 gap-1.5 overflow-x-auto rounded-2xl bg-[var(--paper-2)] p-1 [scrollbar-width:thin] ${
          single ? 'w-[min(48%,12rem)] shrink-0' : 'w-full'
        }`}
      >
        {images.map((src) => (
          <img
            key={src}
            src={src}
            alt=""
            className="h-full w-auto max-w-none shrink-0 rounded-xl object-contain"
            draggable={false}
          />
        ))}
      </div>
      {single ? (
        <div className="min-w-0 flex-1">
          <DetailMeta place={place} compact />
        </div>
      ) : null}
    </div>
  )
}

function DetailMeta({
  place,
  compact = false,
}: {
  place: ExplorePlace
  compact?: boolean
}) {
  return (
    <div className={compact ? 'flex h-full flex-col gap-1.5' : 'space-y-2'}>
      <div className="flex flex-wrap gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-2)] px-2 py-0.5 tabular-nums">
          {formatKm(place.distKm)}
        </span>
        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[color-mix(in_srgb,#b45309_70%,var(--ink))]">
          <span aria-hidden className="text-[10px]">
            ★
          </span>
          {place.rating != null ? place.rating : '—'}
          <span className="text-[9px] text-[var(--ink-muted)]">
            ({place.tags.source === 'google' ? 'Google' : 'OSM'})
          </span>
        </span>
      </div>
      {place.summary ? (
        <p
          className={`leading-relaxed text-[var(--ink)] ${
            compact ? 'line-clamp-5 text-xs' : 'text-sm'
          }`}
        >
          {place.summary}
        </p>
      ) : null}
      {place.address ? (
        <p className={`text-[var(--ink-muted)] ${compact ? 'line-clamp-2 text-[11px]' : 'text-xs'}`}>
          {place.address}
        </p>
      ) : null}
      {place.cuisine ? (
        <p className={`text-[var(--ink-muted)] ${compact ? 'text-[11px]' : 'text-xs'}`}>
          Cuisine: {place.cuisine}
        </p>
      ) : null}
      {place.openingHours ? (
        <p className={`text-[var(--ink-muted)] ${compact ? 'line-clamp-2 text-[11px]' : 'text-xs'}`}>
          Hours: {place.openingHours}
        </p>
      ) : null}
    </div>
  )
}

function ExploreCard({
  place,
  selected,
  onSelect,
}: {
  place: ExplorePlace
  selected: boolean
  onSelect: () => void
}) {
  // List cards: first photo only — swipe handlers fought the horizontal scroller.
  const photo = place.images[0] || ''

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative h-[7.25rem] w-[7.25rem] shrink-0 touch-manipulation overflow-hidden rounded-2xl border-2 text-left shadow-md transition ${
        selected
          ? 'border-[var(--coral)] ring-2 ring-[color-mix(in_srgb,var(--coral)_45%,transparent)]'
          : 'border-[var(--glass-border)] hover:border-[var(--coral)]/50'
      }`}
    >
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--coral)_12%,var(--paper-2))]">
        {photo ? (
          <img src={photo} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-2xl opacity-70">🗺️</div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-black/25" />
      </div>
      <span className="absolute left-1.5 top-1.5 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur-sm">
        {formatKm(place.distKm)}
      </span>
      <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        <span className="text-[9px] text-amber-300" aria-hidden>
          ★
        </span>
        {place.rating != null ? place.rating : '—'}
      </span>
      <span className="absolute bottom-1.5 left-1.5 right-1.5 line-clamp-2 text-[10px] font-semibold leading-tight text-white drop-shadow">
        {place.name}
      </span>
    </button>
  )
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(1)} km`
}

function isValidAnchor(a: { lat: number; lon: number }): boolean {
  return (
    Number.isFinite(a.lat) &&
    Number.isFinite(a.lon) &&
    a.lat >= -90 &&
    a.lat <= 90 &&
    a.lon >= -180 &&
    a.lon <= 180
  )
}
