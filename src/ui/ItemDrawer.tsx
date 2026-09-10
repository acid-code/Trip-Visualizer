import type { TripItem } from '../domain/types'
import { ITEM_STATUSES, ITEM_TYPES, TYPE_COLORS } from '../domain/types'
import { pinItemOnMap } from '../data/enrichment'
import { COMMON_CURRENCIES, normalizeCurrency } from '../data/fx'

type Props = {
  item: TripItem | null
  onChange: (item: TripItem) => void
  onClose: () => void
  onDelete: (id: string) => void
}

export function ItemDrawer({ item, onChange, onClose, onDelete }: Props) {
  if (!item) return null

  const set = <K extends keyof TripItem>(key: K, value: TripItem[K]) => {
    const next: TripItem = {
      ...item,
      [key]: value,
      source: item.source === 'example' ? 'example' : 'app',
    }
    // Filling in a day-base placeholder clears the empty marker
    if (
      next.tags?.includes('placeholder') &&
      (key === 'title' || key === 'place' || key === 'city' || key === 'type' || key === 'lat')
    ) {
      const meaningful =
        (typeof value === 'string' && value.trim() && value !== item.title) ||
        (key === 'type' && value !== 'hotel') ||
        (key === 'lat' && value != null)
      if (meaningful || (key === 'place' && String(value).trim()) || (key === 'city' && String(value).trim())) {
        next.tags = next.tags.filter((t) => t !== 'placeholder')
      }
    }
    onChange(next)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-950"
            style={{ background: TYPE_COLORS[item.type] }}
          >
            {item.type}
          </span>
          <h3 className="mt-1 text-lg font-semibold text-stone-900">{item.title}</h3>
          {item.enrichmentSummary && (
            <p className="mt-1 text-sm text-stone-600">
              {item.enrichmentSummary}
              {item.enrichmentSource ? (
                <span className="text-stone-400"> · {item.enrichmentSource}</span>
              ) : null}
            </p>
          )}
        </div>
        <button className="text-stone-400 hover:text-stone-800" onClick={onClose}>
          Close
        </button>
      </div>

      {item.enrichmentImage ? (
        <img
          src={item.enrichmentImage}
          alt=""
          className="h-36 w-full rounded-lg object-cover"
        />
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Title">
          <input className={inputCls} value={item.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Type">
          <select className={inputCls} value={item.type} onChange={(e) => set('type', e.target.value as TripItem['type'])}>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input className={inputCls} type="date" value={item.date} onChange={(e) => set('date', e.target.value)} />
        </Field>
        <Field label="End date">
          <input className={inputCls} type="date" value={item.endDate || ''} onChange={(e) => set('endDate', e.target.value)} />
        </Field>
        <Field label="Start">
          <input className={inputCls} value={item.start} onChange={(e) => set('start', e.target.value)} placeholder="HH:MM" />
        </Field>
        <Field label="End">
          <input className={inputCls} value={item.end} onChange={(e) => set('end', e.target.value)} placeholder="HH:MM" />
        </Field>
        <Field label="Address / Maps paste">
          <input className={inputCls} value={item.place} onChange={(e) => set('place', e.target.value)} />
        </Field>
        <Field label="City">
          <input className={inputCls} value={item.city} onChange={(e) => set('city', e.target.value)} />
        </Field>
        <Field label="From">
          <input className={inputCls} value={item.from} onChange={(e) => set('from', e.target.value)} />
        </Field>
        <Field label="To">
          <input className={inputCls} value={item.to} onChange={(e) => set('to', e.target.value)} />
        </Field>
        <Field label="Confirm">
          <input className={inputCls} value={item.confirm} onChange={(e) => set('confirm', e.target.value)} />
        </Field>
        <Field label="Status">
          <select className={inputCls} value={item.status} onChange={(e) => set('status', e.target.value as TripItem['status'])}>
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
            value={item.cost ?? ''}
            onChange={(e) => set('cost', e.target.value === '' ? null : Number(e.target.value))}
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
            value={item.lat ?? ''}
            onChange={(e) => set('lat', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Lon">
          <input
            className={inputCls}
            type="number"
            step="any"
            value={item.lon ?? ''}
            onChange={(e) => set('lon', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      </div>
      <p className="text-[11px] text-stone-500">
        Lat/lon fill automatically from the address. Only edit these if the pin is wrong.
      </p>
      <button
        type="button"
        className="w-full rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-900"
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
          onClick={() => onDelete(item.id)}
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
  const n = normalizeCurrency(current || 'EUR')
  set.add(n)
  return [...set]
}
