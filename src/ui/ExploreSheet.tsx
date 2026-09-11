import { useEffect, useMemo, useRef, useState } from 'react'
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

const TYPE_OPTIONS: Array<ExploreCategory | 'all'> = [
  'all',
  'sights',
  'food',
  'drink',
  'nature',
  'other',
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
  const [typeFilter, setTypeFilter] = useState<ExploreCategory | 'all'>('all')
  const [sort, setSort] = useState<ExploreSort>('distance')
  const [typeOpen, setTypeOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  const filtered = useMemo(
    () => filterAndSortExplore(places, typeFilter, sort),
    [places, typeFilter, sort],
  )

  if (!open) return null

  function typeLabel(t: ExploreCategory | 'all') {
    return t === 'all' ? 'All types' : exploreCategoryLabel(t)
  }

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

      <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-100/60 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-stone-400">Type</span>
        <div className="relative">
          <button
            type="button"
            className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] text-stone-700 shadow-sm"
            onClick={() => {
              setTypeOpen((v) => !v)
              setSortOpen(false)
            }}
          >
            {typeLabel(typeFilter)} ▾
          </button>
          {typeOpen ? (
            <div className="absolute left-0 top-7 z-20 min-w-[8rem] overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
              {TYPE_OPTIONS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-xs ${
                    typeFilter === id
                      ? 'bg-amber-50 text-amber-800'
                      : 'text-stone-700 hover:bg-stone-50'
                  }`}
                  onClick={() => {
                    setTypeFilter(id)
                    setTypeOpen(false)
                  }}
                >
                  {typeLabel(id)}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <span className="text-[10px] uppercase tracking-wide text-stone-400">Sort</span>
        <div className="relative">
          <button
            type="button"
            className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] text-stone-700 shadow-sm"
            onClick={() => {
              setSortOpen((v) => !v)
              setTypeOpen(false)
            }}
          >
            {sort === 'distance' ? 'Distance' : sort === 'name' ? 'Name' : 'Rating'} ▾
          </button>
          {sortOpen ? (
            <div className="absolute left-0 top-7 z-20 min-w-[7rem] overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
              {(
                [
                  ['distance', 'Distance'],
                  ['name', 'Name'],
                  ['rating', 'Rating'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-xs ${
                    sort === id ? 'bg-amber-50 text-amber-800' : 'text-stone-700 hover:bg-stone-50'
                  }`}
                  onClick={() => {
                    setSort(id)
                    setSortOpen(false)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <span className="ml-auto text-[10px] tabular-nums text-stone-400">
          {busy ? 'Loading…' : `${filtered.length}`}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {error ? (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        ) : null}
        {busy && !places.length ? (
          <p className="py-6 text-center text-sm text-stone-400">Looking around…</p>
        ) : null}
        {!busy && !filtered.length && !error ? (
          <p className="py-6 text-center text-sm text-stone-400">No places in this filter.</p>
        ) : null}

        <div className="flex gap-2.5 overflow-x-auto pb-1 pt-1 [scrollbar-width:thin]">
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
                  onClick={() =>
                    openExternalUrl(
                      mapsPlaceSearchUrl(detail.name, detail, {
                        address: detail.address,
                        category: detail.category,
                        cuisine: detail.cuisine,
                      }),
                    )
                  }
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
          <span className="text-[9px] text-stone-400">(OSM)</span>
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
  const [photoIdx, setPhotoIdx] = useState(0)
  const startX = useRef<number | null>(null)
  const photos = place.images.length ? place.images : ['']

  useEffect(() => {
    setPhotoIdx(0)
  }, [place.id])

  function onPointerDown(e: React.PointerEvent) {
    startX.current = e.clientX
  }

  function onPointerUp(e: React.PointerEvent) {
    if (startX.current == null || photos.length < 2) {
      startX.current = null
      return
    }
    const dx = e.clientX - startX.current
    startX.current = null
    if (Math.abs(dx) < 28) return
    e.preventDefault()
    e.stopPropagation()
    setPhotoIdx((i) => {
      if (dx < 0) return (i + 1) % photos.length
      return (i - 1 + photos.length) % photos.length
    })
  }

  const photo = photos[photoIdx] || ''

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative h-[7.25rem] w-[7.25rem] shrink-0 overflow-hidden rounded-2xl border-2 text-left shadow-md transition ${
        selected
          ? 'border-amber-400 ring-2 ring-amber-300/70'
          : 'border-white/80 hover:border-amber-200'
      }`}
    >
      <div
        className="absolute inset-0 touch-pan-y bg-gradient-to-br from-stone-200 to-amber-100"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
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
      {photos.length > 1 && photo ? (
        <span className="absolute bottom-1.5 right-1.5 flex gap-0.5">
          {photos.map((_, i) => (
            <span
              key={i}
              className={`h-1 w-1 rounded-full ${i === photoIdx ? 'bg-white' : 'bg-white/40'}`}
            />
          ))}
        </span>
      ) : null}
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
