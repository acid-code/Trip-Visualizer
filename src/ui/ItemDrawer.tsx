import { useEffect } from 'react'
import type { ItemType, TripItem } from '../domain/types'
import { ITEM_STATUSES, ITEM_TYPES, TYPE_COLORS, TYPE_EMOJI } from '../domain/types'
import { pinItemOnMap } from '../data/enrichment'
import { COMMON_CURRENCIES, normalizeCurrency } from '../data/fx'
import {
  mapsPlaceSearchUrl,
  openExternalUrl,
} from '../data/mapsLinks'
import { safeHttpsUrl } from '../data/security'
import {
  applyItemTypeChange,
  rememberCurrentType,
} from '../data/typeSwitch'
import {
  isIsoDate,
  isValidCoord,
  parseLat,
  parseLon,
  parseNonNegativeNumber,
  requireIsoDate,
  sanitizeEndDate,
  sanitizeTime,
  sanitizeTitle,
} from '../data/validate'
import { DateField } from './DateField'

const TYPE_BLURB: Partial<Record<ItemType, string>> = {
  flight: 'Air',
  train: 'Rail',
  bus: 'Coach',
  ferry: 'Boat',
  drive: 'Car',
  hotel: 'Stay',
  sight: 'Visit',
  restaurant: 'Meal',
  activity: 'Ticket',
  city: 'Hub',
  note: 'Note',
  other: 'Other',
}

type Props = {
  item: TripItem | null
  onChange: (item: TripItem) => void
  onClose: () => void
  onDelete: (id: string) => void
}

export function ItemDrawer({ item, onChange, onClose, onDelete }: Props) {
  useEffect(() => {
    if (item) rememberCurrentType(item)
  }, [item?.id])

  if (!item) return null

  const set = <K extends keyof TripItem>(key: K, value: TripItem[K]) => {
    if (key === 'type') {
      const nextType = value as TripItem['type']
      let next = applyItemTypeChange(item, nextType)
      next = {
        ...next,
        source: item.source === 'example' ? 'example' : 'app',
      }
      // Multi-night hotel stay → promote off day-base placeholder
      if (
        next.type === 'hotel' &&
        next.tags?.includes('placeholder') &&
        isIsoDate(next.date) &&
        isIsoDate(next.endDate) &&
        next.endDate > next.date
      ) {
        next = { ...next, tags: next.tags.filter((t) => t !== 'placeholder') }
      }
      if (next.tags?.includes('placeholder') && nextType !== 'hotel') {
        next = { ...next, tags: next.tags.filter((t) => t !== 'placeholder') }
      }
      onChange(next)
      return
    }

    const next: TripItem = {
      ...item,
      [key]: value,
      source: item.source === 'example' ? 'example' : 'app',
    }

    if (key === 'title') {
      next.title = sanitizeTitle(String(value), item.title || 'Untitled')
    }
    if (key === 'date') {
      const d = requireIsoDate(String(value), item.date)
      next.date = d
      next.endDate = sanitizeEndDate(d, next.endDate || '')
    }
    if (key === 'endDate') {
      next.endDate = sanitizeEndDate(next.date, String(value ?? ''))
    }
    if (key === 'start' || key === 'end') {
      // Keep raw text while typing — sanitize on blur only (HH:MM rejects mid-edit).
      next[key] = String(value ?? '') as TripItem[typeof key]
    }
    if (key === 'currency') {
      next.currency = normalizeCurrency(String(value ?? 'EUR'))
    }

    // Multi-night hotel stay → promote off day-base placeholder so the trip can widen
    if (
      next.type === 'hotel' &&
      next.tags?.includes('placeholder') &&
      isIsoDate(next.date) &&
      isIsoDate(next.endDate) &&
      next.endDate > next.date
    ) {
      next.tags = next.tags.filter((t) => t !== 'placeholder')
    }

    if (
      next.tags?.includes('placeholder') &&
      (key === 'title' || key === 'place' || key === 'city' || key === 'lat')
    ) {
      const meaningful =
        (typeof value === 'string' && value.trim() && value !== item.title) ||
        (key === 'lat' && value != null)
      if (
        meaningful ||
        (key === 'place' && String(value).trim()) ||
        (key === 'city' && String(value).trim())
      ) {
        next.tags = next.tags.filter((t) => t !== 'placeholder')
      }
    }
    onChange(next)
  }

  const canPin = Boolean(
    item.place?.trim() ||
      item.from?.trim() ||
      item.to?.trim() ||
      item.geocodeQuery?.trim() ||
      (item.city?.trim() && item.title?.trim()),
  )

  const leg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(item.type)
  const hotel = item.type === 'hotel'
  const mapsUri = safeHttpsUrl(item.googleMapsUri || '')
  const fromGoogle =
    item.enrichmentSource === 'Google' || Boolean(mapsUri)
  const reviewsUrl =
    mapsUri ||
    (fromGoogle && isValidCoord(item.lat, item.lon)
      ? mapsPlaceSearchUrl(
          item.title || item.place,
          { lat: item.lat!, lon: item.lon! },
          item.place || undefined,
        )
      : '')
  const showGoogleMeta =
    fromGoogle && (item.rating != null || Boolean(reviewsUrl))

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-950"
            style={{ background: TYPE_COLORS[item.type] }}
          >
            <span aria-hidden className="text-[12px] leading-none">
              {TYPE_EMOJI[item.type]}
            </span>
            {item.type}
          </span>
          <h3 className="mt-1 text-lg font-semibold text-stone-900">{item.title}</h3>
          {showGoogleMeta ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {item.rating != null ? (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  <span aria-hidden className="text-[11px] text-amber-500">
                    ★
                  </span>
                  <span className="tabular-nums">{item.rating}</span>
                  <span className="text-[9px] font-normal text-stone-400">
                    Google
                  </span>
                </span>
              ) : null}
              {reviewsUrl ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-stone-700 shadow-sm hover:border-amber-300 hover:bg-amber-50"
                  title="Open Google Maps reviews"
                  onClick={() => openExternalUrl(reviewsUrl)}
                >
                  Reviews
                  <span aria-hidden className="text-[10px] text-stone-400">
                    ↗
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}
          {item.enrichmentSummary && (
            <p className="mt-1 text-sm text-stone-600">
              {item.enrichmentSummary}
              {item.enrichmentSource ? (
                <span className="text-stone-400"> · {item.enrichmentSource}</span>
              ) : null}
            </p>
          )}
        </div>
        <button className="text-stone-400 hover:text-stone-800" onClick={onClose} title="Discard edits and close">
          Close
        </button>
      </div>

      {safeHttpsUrl(item.enrichmentImage) ? (
        <img
          src={safeHttpsUrl(item.enrichmentImage)}
          alt=""
          referrerPolicy="no-referrer"
          className="h-36 w-full rounded-lg object-cover"
        />
      ) : null}

      <div>
        <div className="mb-1.5 text-xs font-medium text-stone-500">Type</div>
        <div
          className="grid grid-cols-4 gap-1.5 sm:grid-cols-6"
          role="listbox"
          aria-label="Step type"
          title="Switching type remembers each type’s fields for this step. Shared fields like confirm, place, and cost carry over."
        >
          {ITEM_TYPES.map((t) => {
            const on = item.type === t
            return (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => set('type', t)}
                className={`flex flex-col items-center gap-0.5 rounded-2xl border px-1 py-2 text-center transition ${
                  on
                    ? 'border-transparent text-white shadow-sm'
                    : 'border-stone-200/90 bg-white text-stone-700 hover:border-orange-200 hover:bg-orange-50/40'
                }`}
                style={on ? { background: TYPE_COLORS[t] } : undefined}
              >
                <span aria-hidden className="text-[17px] leading-none">
                  {TYPE_EMOJI[t]}
                </span>
                <span className="text-[10px] font-semibold capitalize leading-tight">
                  {t}
                </span>
                <span
                  className={`text-[9px] leading-tight ${
                    on ? 'text-white/80' : 'text-stone-400'
                  }`}
                >
                  {TYPE_BLURB[t] ?? ''}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Title *">
          <input
            className={inputCls}
            value={item.title}
            required
            onChange={(e) => set('title', e.target.value)}
            onBlur={(e) => set('title', sanitizeTitle(e.target.value, item.title))}
          />
        </Field>
        <Field label="Date *">
          <DateField
            className={inputCls}
            value={isIsoDate(item.date) ? item.date : ''}
            required
            onChange={(v) => {
              if (!v) return
              set('date', v)
            }}
            aria-label="Step date"
          />
        </Field>
        {(hotel || leg) && (
          <Field label={hotel ? 'Check-out' : 'End date'}>
            <DateField
              className={inputCls}
              value={item.endDate && isIsoDate(item.endDate) ? item.endDate : ''}
              min={isIsoDate(item.date) ? item.date : undefined}
              onChange={(v) => set('endDate', v)}
              aria-label={hotel ? 'Check-out date' : 'End date'}
              placeholder="Optional"
            />
          </Field>
        )}
        <Field label="Start">
          <input
            className={inputCls}
            value={item.start}
            onChange={(e) => set('start', e.target.value)}
            onBlur={(e) => set('start', sanitizeTime(e.target.value))}
            placeholder="HH:MM"
          />
        </Field>
        <Field label="End">
          <input
            className={inputCls}
            value={item.end}
            onChange={(e) => set('end', e.target.value)}
            onBlur={(e) => set('end', sanitizeTime(e.target.value))}
            placeholder="HH:MM"
          />
        </Field>
        <Field label="Address / Maps paste">
          <input
            className={inputCls}
            value={item.place}
            onChange={(e) => set('place', e.target.value)}
          />
        </Field>
        <Field label="City">
          <input
            className={inputCls}
            value={item.city}
            onChange={(e) => set('city', e.target.value)}
          />
        </Field>
        {leg ? (
          <>
            <Field label="From">
              <input
                className={inputCls}
                value={item.from}
                onChange={(e) => set('from', e.target.value)}
              />
            </Field>
            <Field label="To">
              <input
                className={inputCls}
                value={item.to}
                onChange={(e) => set('to', e.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field label="Confirm">
          <input
            className={inputCls}
            value={item.confirm}
            onChange={(e) => set('confirm', e.target.value)}
            placeholder="Booking / confirmation ref"
          />
        </Field>
        <Field label="Status">
          <select
            className={inputCls}
            value={item.status}
            onChange={(e) => set('status', e.target.value as TripItem['status'])}
          >
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cost">
          <input
            className={inputCls}
            type="number"
            step="any"
            min="0"
            value={item.cost ?? ''}
            onChange={(e) => set('cost', parseNonNegativeNumber(e.target.value))}
          />
        </Field>
        <Field label="Currency">
          <select
            className={inputCls}
            value={normalizeCurrency(item.currency || 'EUR')}
            onChange={(e) => set('currency', e.target.value)}
          >
            {currencyChoices(item.currency).map((c) => (
              <option key={c} value={c}>
                {c === 'ILS' ? 'ILS (NIS)' : c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lat">
          <input
            className={inputCls}
            type="number"
            step="any"
            min={-90}
            max={90}
            value={item.lat ?? ''}
            onChange={(e) => set('lat', parseLat(e.target.value))}
          />
        </Field>
        <Field label="Lon">
          <input
            className={inputCls}
            type="number"
            step="any"
            min={-180}
            max={180}
            value={item.lon ?? ''}
            onChange={(e) => set('lon', parseLon(e.target.value))}
          />
        </Field>
      </div>
      <p className="text-[11px] text-stone-500">
        Lat/lon fill automatically from the address. Only edit these if the pin is wrong.
        Changing type remembers each type’s details for this step; shared fields (confirm, place,
        cost…) carry over.
      </p>
      <button
        type="button"
        disabled={!canPin}
        className="w-full rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          void (async () => {
            const pinned = await pinItemOnMap(item)
            onChange(pinned)
          })()
        }}
      >
        Find on map from address
      </button>
      <Field label="Notes">
        <textarea
          className={`${inputCls} min-h-20`}
          value={item.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <button
          className="rounded-lg bg-rose-600/90 px-3 py-2 text-sm text-white"
          onClick={() => {
            if (window.confirm(`Delete “${item.title}”?`)) onDelete(item.id)
          }}
        >
          Delete
        </button>
        {item.url ? (
          <a
            className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-sky-300"
            href={item.url}
            target="_blank"
            rel="noreferrer"
          >
            Open link
          </a>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-stone-500">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-xl border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 outline-none focus:border-orange-400'

function currencyChoices(current?: string) {
  const set = new Set<string>([...COMMON_CURRENCIES])
  set.add(normalizeCurrency(current || 'EUR'))
  return [...set]
}
