import { useMemo, useState } from 'react'
import {
  type ItemType,
  type TripItem,
  type TripMeta,
} from '../domain/types'
import { TYPE_COLORS } from '../domain/types'
import { createId, sortItems } from '../data/db'
import { COMMON_CURRENCIES } from '../data/fx'

export type AddContext = {
  afterId?: string | null
  beforeId?: string | null
  /** Prefilled when inserting between steps */
  hint?: string
}

type Props = {
  meta: TripMeta
  items: TripItem[]
  context?: AddContext | null
  onCreate: (item: TripItem) => void
  onCancel: () => void
}

const TYPE_META: { type: ItemType; emoji: string; blurb: string }[] = [
  { type: 'sight', emoji: '📍', blurb: 'Place to visit' },
  { type: 'restaurant', emoji: '🍽️', blurb: 'Meal / café' },
  { type: 'hotel', emoji: '🛏️', blurb: 'Stay overnight' },
  { type: 'activity', emoji: '🎟️', blurb: 'Tour or ticket' },
  { type: 'drive', emoji: '🚗', blurb: 'Car leg' },
  { type: 'flight', emoji: '✈️', blurb: 'Flight' },
  { type: 'train', emoji: '🚆', blurb: 'Train' },
  { type: 'bus', emoji: '🚌', blurb: 'Bus' },
  { type: 'ferry', emoji: '⛴️', blurb: 'Ferry' },
  { type: 'city', emoji: '🏙️', blurb: 'City hub' },
  { type: 'other', emoji: '✨', blurb: 'Anything else' },
]

function midpointTime(a?: string, b?: string): string {
  const toMin = (t?: string) => {
    if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const am = toMin(a)
  const bm = toMin(b)
  if (am == null && bm == null) return ''
  if (am == null) return b || ''
  if (bm == null) return a || ''
  const mid = Math.round((am + bm) / 2)
  const hh = String(Math.floor(mid / 60) % 24).padStart(2, '0')
  const mm = String(mid % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

export function AddStepPanel({ meta, items, context, onCreate, onCancel }: Props) {
  const sorted = useMemo(() => sortItems(items), [items])
  const after = context?.afterId
    ? sorted.find((i) => i.id === context.afterId)
    : null
  const before = context?.beforeId
    ? sorted.find((i) => i.id === context.beforeId)
    : null

  const defaults = useMemo(() => {
    const date = after?.date || before?.date || meta.startDate
    const start = midpointTime(after?.end || after?.start, before?.start)
    const city = after?.city || before?.city || ''
    return { date, start, city }
  }, [after, before, meta.startDate])

  const [type, setType] = useState<ItemType>('sight')
  const [title, setTitle] = useState('')
  const [place, setPlace] = useState('')
  const [city, setCity] = useState(defaults.city)
  const [date, setDate] = useState(defaults.date)
  const [endDate, setEndDate] = useState('')
  const [start, setStart] = useState(defaults.start)
  const [end, setEnd] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [notes, setNotes] = useState('')
  const [cost, setCost] = useState('')
  const [currency, setCurrency] = useState(meta.homeCurrency || 'EUR')

  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(type)
  const isHotel = type === 'hotel'

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !date) return
    const item: TripItem = {
      id: createId(type[0]?.toUpperCase() ?? 'X'),
      type,
      title: title.trim(),
      place: place.trim(),
      city: city.trim(),
      date,
      endDate: isHotel || isLeg ? endDate : '',
      start,
      end,
      from: isLeg ? from.trim() : '',
      to: isLeg ? to.trim() : '',
      confirm: '',
      cost: (() => {
        if (cost.trim() === '') return null
        const n = Number(cost)
        return Number.isFinite(n) ? n : null
      })(),
      currency: currency.trim() || meta.homeCurrency,
      status: 'planned',
      notes: notes.trim(),
      url: '',
      tags: [],
      lat: null,
      lon: null,
      latTo: null,
      lonTo: null,
      wikidata: '',
      osmId: '',
      geocodeQuery: place.trim(),
      updatedAt: '',
      enrichmentSummary: '',
      enrichmentImage: '',
      enrichmentSource: '',
      routeCoords: [],
      source: 'app',
    }
    onCreate(item)
  }

  return (
    <form
      className="flex h-full min-h-0 flex-col text-stone-800"
      onSubmit={submit}
    >
      <div className="flex items-start justify-between gap-2 pb-2">
        <div>
          <h3 className="brand-mark text-xl text-stone-900">New step</h3>
          <p className="mt-0.5 text-xs text-stone-500">
            {context?.hint ||
              (after || before
                ? `Slots between ${after?.title ?? 'start'} → ${before?.title ?? 'end'}. Date/time auto-sorts the timeline.`
                : 'Name it, paste an address, pick date — it lands on the map automatically.')}
          </p>
        </div>
        <button type="button" className="text-sm text-stone-500" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pb-4">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {TYPE_META.map((t) => {
            const on = type === t.type
            return (
              <button
                key={t.type}
                type="button"
                onClick={() => setType(t.type)}
                className={`rounded-2xl border px-2 py-3 text-center transition ${
                  on
                    ? 'border-transparent text-white shadow-md'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-orange-200'
                }`}
                style={on ? { background: TYPE_COLORS[t.type] } : undefined}
              >
                <div className="text-lg leading-none">{t.emoji}</div>
                <div className="mt-1 text-[11px] font-semibold capitalize">{t.type}</div>
                <div className={`mt-0.5 text-[10px] ${on ? 'text-white/80' : 'text-stone-400'}`}>
                  {t.blurb}
                </div>
              </button>
            )
          })}
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
          <label className="block text-xs font-medium text-stone-500">
            Name
            <input
              className={inputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isLeg ? 'TGV to Marseille' : 'Louvre morning'}
              required
              autoFocus
            />
            <span className="mt-1 block text-[10px] font-normal text-stone-400">
              Short label for the timeline (not the map address).
            </span>
          </label>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-stone-500">
              Date
              <input
                className={inputCls}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </label>
            <label className="block text-xs font-medium text-stone-500">
              Time
              <input
                className={inputCls}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                placeholder="HH:MM"
              />
            </label>
            {(isHotel || isLeg) && (
              <>
                <label className="block text-xs font-medium text-stone-500">
                  End date
                  <input
                    className={inputCls}
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </label>
                <label className="block text-xs font-medium text-stone-500">
                  End time
                  <input
                    className={inputCls}
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    placeholder="HH:MM"
                  />
                </label>
              </>
            )}
          </div>

          {!isLeg ? (
            <div className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-stone-500">
                Address or place
                <input
                  className={inputCls}
                  value={place}
                  onChange={(e) => setPlace(e.target.value)}
                  placeholder="Paste Google Maps address or link"
                />
              </label>
              <label className="block text-xs font-medium text-stone-500">
                City
                <input
                  className={inputCls}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Helps if the address is short"
                />
              </label>
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="block text-xs font-medium text-stone-500">
                From
                <input
                  className={inputCls}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="CDG or address / Maps link"
                />
              </label>
              <label className="block text-xs font-medium text-stone-500">
                To
                <input
                  className={inputCls}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="MRS or address / Maps link"
                />
              </label>
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-stone-500">
              Price
              <input
                className={inputCls}
                type="number"
                step="any"
                min="0"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0"
              />
            </label>
            <label className="block text-xs font-medium text-stone-500">
              Currency
              <select
                className={inputCls}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencyChoices(meta.homeCurrency).map((c) => (
                  <option key={c} value={c}>
                    {c === 'ILS' ? 'ILS (NIS)' : c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 block text-xs font-medium text-stone-500">
            Notes (optional)
            <textarea
              className={`${inputCls} min-h-16`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Booking ref, tips…"
            />
          </label>
        </div>

        <p className="text-[11px] leading-relaxed text-stone-500">
          You don’t need lat/lon. Paste a normal address or a Google Maps link into{' '}
          <strong>Address or place</strong> (or From/To for trips) — we look it up and drop a pin.
          Drive/walk paths draw once both ends have locations.
        </p>
      </div>

      <button
        type="submit"
        className="mt-auto w-full rounded-full bg-[var(--coral)] py-3 text-sm font-semibold text-white shadow-lg shadow-orange-900/20"
      >
        Add to plan
      </button>
    </form>
  )
}

const inputCls =
  'mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-900 outline-none focus:border-orange-400 focus:bg-white'

function currencyChoices(home: string) {
  const set = new Set<string>([...COMMON_CURRENCIES, (home || 'EUR').toUpperCase()])
  if (set.has('NIS')) {
    set.delete('NIS')
    set.add('ILS')
  }
  return [...set]
}
