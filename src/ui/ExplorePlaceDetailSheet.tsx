import {
  exploreCategoryLabel,
  type ExplorePlace,
} from '../data/explore'
import { mapsPlaceSearchUrl, openExternalUrl } from '../data/mapsLinks'

type Props = {
  place: ExplorePlace
  onClose: () => void
  primaryLabel: string
  onPrimary: () => void
  /** Soft overlay behind the sheet (Plan floats over the map). */
  backdrop?: boolean
}

/** Shared place detail sheet — Journey Explore + Plan Discover. */
export function ExplorePlaceDetailSheet({
  place,
  onClose,
  primaryLabel,
  onPrimary,
  backdrop = true,
}: Props) {
  return (
    <div
      className={
        backdrop
          ? 'absolute inset-0 z-30 flex flex-col bg-[color-mix(in_srgb,var(--bg)_45%,transparent)] backdrop-blur-[2px]'
          : 'absolute inset-0 z-30 flex flex-col pointer-events-none'
      }
      onClick={backdrop ? onClose : undefined}
      role={backdrop ? 'presentation' : undefined}
    >
      <div
        className="pointer-events-auto mt-auto max-h-[min(72vh,30rem)] overflow-y-auto overscroll-contain touch-pan-y rounded-t-3xl border border-[var(--glass-border)] bg-[var(--paper-solid)] text-[var(--ink)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--glass-border)] bg-[var(--paper)] px-4 py-2.5 backdrop-blur">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--teal)]">
              {exploreCategoryLabel(place.category)}
            </div>
            <h3 className="truncate text-sm font-semibold text-[var(--ink)]">{place.name}</h3>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] text-[var(--ink-muted)]"
            title="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="space-y-2.5 px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <DetailMedia place={place} />
          {place.images.length !== 1 ? <DetailMeta place={place} /> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] shadow-sm"
              onClick={() => {
                const mapsUri = place.tags.googleMapsUri
                openExternalUrl(
                  mapsUri ||
                    mapsPlaceSearchUrl(place.name, place, {
                      address: place.address,
                      category: place.category,
                      cuisine: place.cuisine,
                    }),
                )
              }}
            >
              Google Maps · reviews
            </button>
            {place.menuUrl &&
            (place.category === 'food' || place.category === 'drink') ? (
              <button
                type="button"
                className="rounded-full border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-[color-mix(in_srgb,#b45309_70%,var(--ink))] shadow-sm"
                onClick={() => openExternalUrl(place.menuUrl)}
              >
                Menu
              </button>
            ) : null}
            {place.website ? (
              <button
                type="button"
                className="rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] px-3 py-1.5 text-xs font-medium text-[var(--sky)] shadow-sm"
                onClick={() => openExternalUrl(place.website)}
              >
                Website
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="w-full rounded-2xl bg-[var(--coral)] py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95"
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

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

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(1)} km`
}
