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
    tone: 'border-orange-200/80 bg-orange-50/70 text-orange-800',
    toneActive: 'border-orange-400 bg-orange-500 text-white shadow-sm shadow-orange-200',
  },
  {
    id: 'drink',
    short: 'Drinks',
    tone: 'border-violet-200/80 bg-violet-50/70 text-violet-800',
    toneActive: 'border-violet-400 bg-violet-500 text-white shadow-sm shadow-violet-200',
  },
  {
    id: 'sights',
    short: 'Sights',
    tone: 'border-sky-200/80 bg-sky-50/70 text-sky-800',
    toneActive: 'border-sky-400 bg-sky-500 text-white shadow-sm shadow-sky-200',
  },
  {
    id: 'hotel',
    short: 'Hotels',
    tone: 'border-teal-200/80 bg-teal-50/70 text-teal-800',
    toneActive: 'border-teal-400 bg-teal-600 text-white shadow-sm shadow-teal-200',
  },
  {
    id: 'nature',
    short: 'Nature',
    tone: 'border-lime-200/80 bg-lime-50/70 text-lime-900',
    toneActive: 'border-lime-500 bg-lime-600 text-white shadow-sm shadow-lime-200',
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
    <div className="relative flex h-full min-h-0 flex-col bg-gradient-to-b from-stone-50 to-amber-50/40 text-stone-800">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100/80 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700/80">
              Nearby
            </div>
            <h2 className="text-base font-semibold text-stone-900">Explore</h2>
          </div>
          {anchor && isValidAnchor(anchor) ? (
            <button
              type="button"
              className="mt-2 rounded-full bg-[#1a73e8] px-2.5 py-1 text-[10px] font-semibold tracking-wide text-white shadow-sm hover:bg-[#1557b0]"
              title="Open this area in Google Maps"
              onClick={() =>
                openExternalUrl(mapsNearbyExploreUrl(anchor, anchor.label))
              }
            >
              Google
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-600 shadow-sm"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="shrink-0 space-y-2 border-b border-amber-100/60 px-3 py-2.5">
        <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-stone-200/90 bg-white/80 p-0.5 shadow-sm">
            {SORT_OPTIONS.map((opt) => {
              const active = sort === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`rounded-lg px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors duration-150 ${
                    active
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-500 hover:text-stone-800'
                  }`}
                  onClick={() => setSort(opt.id)}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <span className="ml-auto text-[10px] tabular-nums text-stone-400">
            {busy ? 'Loading…' : `${filtered.length} · ${exploreCategoryLabel(typeFilter)}`}
          </span>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-hidden px-3 py-2"
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {error ? (
          <p className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        ) : null}
        {busy && !places.length ? (
          <p className="py-6 text-center text-sm text-stone-400">Looking around…</p>
        ) : null}
        {!busy && !filtered.length && !error ? (
          <p className="py-6 text-center text-sm text-stone-400">
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
        <div className="absolute inset-0 z-20 flex flex-col bg-stone-950/25 backdrop-blur-[2px]">
          <div className="mt-auto max-h-[90%] overflow-y-auto rounded-t-3xl border border-stone-200 bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-stone-100 bg-white/95 px-4 py-2.5 backdrop-blur">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                  {exploreCategoryLabel(detail.category)}
                </div>
                <h3 className="truncate text-sm font-semibold text-stone-900">{detail.name}</h3>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-600"
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
                  className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 shadow-sm"
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
                    className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm"
                    onClick={() => openExternalUrl(detail.menuUrl)}
                  >
                    Menu
                  </button>
                ) : null}
                {detail.website ? (
                  <button
                    type="button"
                    className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-sky-700 shadow-sm"
                    onClick={() => openExternalUrl(detail.website)}
                  >
                    Website
                  </button>
                ) : null}
              </div>

              <button
                type="button"
                className="w-full rounded-2xl bg-amber-500 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-600"
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
      <div className="flex h-24 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-100 to-orange-100 text-2xl">
        📍
      </div>
    )
  }

  return (
    <div className={`flex gap-3 ${single ? 'items-stretch' : 'flex-col'}`}>
      <div
        className={`flex h-36 gap-1.5 overflow-x-auto rounded-2xl bg-stone-100/80 p-1 [scrollbar-width:thin] ${
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
      <div className="flex flex-wrap gap-1.5 text-xs text-stone-600">
        <span className="rounded-full bg-stone-100 px-2 py-0.5 tabular-nums">
          {formatKm(place.distKm)}
        </span>
        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">
          <span aria-hidden className="text-[10px]">
            ★
          </span>
          {place.rating != null ? place.rating : '—'}
          <span className="text-[9px] text-stone-400">
            ({place.tags.source === 'google' ? 'Google' : 'OSM'})
          </span>
        </span>
      </div>
      {place.summary ? (
        <p
          className={`leading-relaxed text-stone-700 ${
            compact ? 'line-clamp-5 text-xs' : 'text-sm'
          }`}
        >
          {place.summary}
        </p>
      ) : null}
      {place.address ? (
        <p className={`text-stone-500 ${compact ? 'line-clamp-2 text-[11px]' : 'text-xs'}`}>
          {place.address}
        </p>
      ) : null}
      {place.cuisine ? (
        <p className={`text-stone-500 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          Cuisine: {place.cuisine}
        </p>
      ) : null}
      {place.openingHours ? (
        <p className={`text-stone-500 ${compact ? 'line-clamp-2 text-[11px]' : 'text-xs'}`}>
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
          ? 'border-amber-400 ring-2 ring-amber-300/70'
          : 'border-white/80 hover:border-amber-200'
      }`}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-stone-200 to-amber-100">
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
