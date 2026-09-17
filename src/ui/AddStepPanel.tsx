import { useMemo, useState } from 'react'
import {
  TYPE_COLORS,
  TYPE_EMOJI,
  type ItemType,
  type TripItem,
  type TripMeta,
} from '../domain/types'
import { createId, sortItems } from '../data/db'
import { COMMON_CURRENCIES, normalizeCurrency } from '../data/fx'
import { suggestInsertSlot } from '../data/insertSlot'
import {
  isIsoDate,
  parseNonNegativeNumber,
  requireIsoDate,
  sanitizeEndDate,
  sanitizeTime,
  validateAddStep,
} from '../data/validate'
import { DateField } from './DateField'

export type AddContext = {
  afterId?: string | null
  beforeId?: string | null
  /** Prefilled when inserting between steps */
  hint?: string
  /** Replace an auto-generated day-base placeholder with this new step */
  replaceId?: string
  /** Force date (e.g. when filling a day base) */
  date?: string
  /** Suggested starting type when filling a day base */
  defaultType?: ItemType
}

type Props = {
  meta: TripMeta
  items: TripItem[]
  context?: AddContext | null
  onCreate: (item: TripItem) => void
  onCancel: () => void
}

const TYPE_META: { type: ItemType; blurb: string }[] = [
  { type: 'sight', blurb: 'Place to visit' },
  { type: 'restaurant', blurb: 'Meal / café' },
  { type: 'hotel', blurb: 'Stay overnight' },
  { type: 'activity', blurb: 'Tour or ticket' },
  { type: 'drive', blurb: 'Car leg' },
  { type: 'flight', blurb: 'Flight' },
  { type: 'train', blurb: 'Rail' },
  { type: 'bus', blurb: 'Coach' },
  { type: 'ferry', blurb: 'Boat' },
  { type: 'city', blurb: 'City hub' },
  { type: 'other', blurb: 'Anything else' },
]

export function AddStepPanel({ meta, items, context, onCreate, onCancel }: Props) {
  const sorted = useMemo(() => sortItems(items), [items])
  const after = context?.afterId
    ? sorted.find((i) => i.id === context.afterId)
    : null
  const before = context?.beforeId
    ? sorted.find((i) => i.id === context.beforeId)
    : null

  const defaults = useMemo(() => {
    const slot = suggestInsertSlot(after, before, meta.startDate)
    const city = after?.city || before?.city || ''
    const type = context?.defaultType ?? 'sight'
    const date = context?.date
      ? requireIsoDate(context.date, slot.date)
      : slot.date
    return { date, start: slot.start, city, type }
  }, [after, before, meta.startDate, context?.date, context?.defaultType])

  const [type, setType] = useState<ItemType>(defaults.type)
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
  const [currency, setCurrency] = useState(
    normalizeCurrency(meta.homeCurrency || 'EUR'),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(type)
  const isHotel = type === 'hotel'

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const check = validateAddStep({
      type,
      title,
      date,
      endDate,
      start,
      end,
      place,
      from,
      to,
      cost,
      isLeg,
      isHotel,
    })
    if (!check.ok) {
      setErrors(check.errors)
      return
    }
    setErrors({})

    const safeDate = requireIsoDate(date, defaults.date)
    const safeEnd = isHotel || isLeg ? sanitizeEndDate(safeDate, endDate) : ''
    const costNum = parseNonNegativeNumber(cost)

    const item: TripItem = {
      id: createId(type[0]?.toUpperCase() ?? 'X'),
      type,
      title: title.trim(),
      place: place.trim(),
      city: city.trim(),
      date: safeDate,
      endDate: safeEnd,
      start: sanitizeTime(start),
      end: sanitizeTime(end),
      from: isLeg ? from.trim() : '',
      to: isLeg ? to.trim() : '',
      confirm: '',
      cost: costNum,
      currency: normalizeCurrency(currency || meta.homeCurrency),
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
    rating: null,
    googleMapsUri: '',
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

  const fieldErr = (key: string) =>
    errors[key] ? (
      <span className="mt-1 block text-[10px] font-medium text-rose-600">{errors[key]}</span>
    ) : null

  return (
    <form
      className="flex h-full min-h-0 flex-col text-stone-800"
      onSubmit={submit}
      noValidate
    >
      <div className="flex items-start justify-between gap-2 pb-2">
        <div>
          <h3 className="brand-mark text-xl text-stone-900">New step</h3>
          <p className="mt-0.5 text-xs text-stone-500">
            {context?.hint ||
              (context?.replaceId
                ? 'This day needs a real start — hotel, arrival, or station.'
                : after || before
                  ? `Slots between ${after?.title ?? 'start'} → ${before?.title ?? 'end'}. Date/time auto-sorts the timeline.`
                  : 'Name it, paste an address, pick date — it lands on the map automatically.')}
          </p>
        </div>
        <button type="button" className="text-sm text-stone-500" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pb-8">
        {/* Name + dates first so the native date picker isn't buried under the fold */}
        <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
          <label className="block text-xs font-medium text-stone-500">
            Name *
            <input
              className={`${inputCls} ${errors.title ? 'border-rose-400' : ''}`}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setErrors((er) => ({ ...er, title: '' }))
              }}
              placeholder={isLeg ? 'TGV to Marseille' : 'Louvre morning'}
              autoFocus
            />
            {fieldErr('title')}
          </label>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-stone-500">
              Date *
              <DateField
                className={`${inputCls} ${errors.date ? 'border-rose-400' : ''}`}
                value={isIsoDate(date) ? date : ''}
                required
                onChange={(v) => {
                  setDate(v)
                  setErrors((er) => ({ ...er, date: '' }))
                }}
                aria-label="Step date"
              />
              {fieldErr('date')}
            </label>
            <label className="block text-xs font-medium text-stone-500">
              Time
              <input
                className={`${inputCls} ${errors.start ? 'border-rose-400' : ''}`}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                onBlur={() => setStart(sanitizeTime(start))}
                placeholder="HH:MM"
              />
              {fieldErr('start')}
            </label>
            {(isHotel || isLeg) && (
              <>
                <label className="block text-xs font-medium text-stone-500">
                  End date
                  <DateField
                    className={`${inputCls} ${errors.endDate ? 'border-rose-400' : ''}`}
                    value={endDate}
                    min={date || undefined}
                    onChange={(v) => setEndDate(v)}
                    aria-label="End date"
                    placeholder="Optional"
                  />
                  {fieldErr('endDate')}
                </label>
                <label className="block text-xs font-medium text-stone-500">
                  End time
                  <input
                    className={`${inputCls} ${errors.end ? 'border-rose-400' : ''}`}
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    onBlur={() => setEnd(sanitizeTime(end))}
                    placeholder="HH:MM"
                  />
                  {fieldErr('end')}
                </label>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-stone-500">Type</div>
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
                  <div className="text-lg leading-none">{TYPE_EMOJI[t.type]}</div>
                  <div className="mt-1 text-[11px] font-semibold capitalize">{t.type}</div>
                  <div className={`mt-0.5 text-[10px] ${on ? 'text-white/80' : 'text-stone-400'}`}>
                    {t.blurb}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
          {!isLeg ? (
            <div className="space-y-2">
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
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs font-medium text-stone-500">
                From
                <input
                  className={`${inputCls} ${errors.from ? 'border-rose-400' : ''}`}
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value)
                    setErrors((er) => ({ ...er, from: '' }))
                  }}
                  placeholder="CDG or address / Maps link"
                />
                {fieldErr('from')}
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
                className={`${inputCls} ${errors.cost ? 'border-rose-400' : ''}`}
                type="number"
                step="any"
                min="0"
                value={cost}
                onChange={(e) => {
                  setCost(e.target.value)
                  setErrors((er) => ({ ...er, cost: '' }))
                }}
                placeholder="0"
              />
              {fieldErr('cost')}
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
          Required: name + date. Paste an address or Maps link for the map pin. Drive/walk paths
          need locations on both ends.
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
  const set = new Set<string>([...COMMON_CURRENCIES, normalizeCurrency(home || 'EUR')])
  return [...set]
}
