import { z } from 'zod'
import { safeHttpsUrl, sanitizeEntityId, clampText } from '../data/security'

export const ITEM_TYPES = [
  'flight',
  'train',
  'bus',
  'ferry',
  'drive',
  'hotel',
  'sight',
  'restaurant',
  'activity',
  'city',
  'note',
  'other',
] as const

export const ITEM_STATUSES = ['planned', 'booked', 'done', 'cancelled'] as const

export type ItemType = (typeof ITEM_TYPES)[number]
export type ItemStatus = (typeof ITEM_STATUSES)[number]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME_HM = /^([01]?\d|2[0-3]):([0-5]\d)$|^$/

const boundedStr = (max: number, fallback = '') =>
  z
    .unknown()
    .transform((v) => clampText(v, max, fallback))
    .pipe(z.string().max(max))

const optionalIsoDate = z
  .unknown()
  .transform((v) => {
    const s = clampText(v, 10)
    return ISO_DATE.test(s) ? s : ''
  })

const requiredIsoDate = z
  .unknown()
  .transform((v) => clampText(v, 10))
  .refine((s) => ISO_DATE.test(s), { message: 'Invalid date' })

const finiteOrNull = z
  .union([z.number(), z.null(), z.undefined(), z.nan()])
  .transform((v) => {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null
    return v as number
  })
  .nullable()

export const TripMetaSchema = z.object({
  name: boundedStr(200, 'Untitled trip').pipe(z.string().min(1).max(200)),
  startDate: requiredIsoDate,
  endDate: requiredIsoDate,
  homeCurrency: boundedStr(8, 'EUR').pipe(z.string().min(1).max(8)),
  timezoneNote: boundedStr(200, 'All times are local'),
  travelers: boundedStr(200),
  notes: boundedStr(5000),
})

export const TripItemSchema = z.object({
  id: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? ''), 64))
    .pipe(z.string().min(1).max(64)),
  type: z.enum(ITEM_TYPES),
  title: boundedStr(300, 'Untitled').pipe(z.string().min(1).max(300)),
  place: boundedStr(500),
  city: boundedStr(120),
  date: requiredIsoDate,
  endDate: optionalIsoDate,
  start: z
    .unknown()
    .transform((v) => {
      const s = clampText(v, 5)
      return TIME_HM.test(s) ? s : ''
    }),
  end: z
    .unknown()
    .transform((v) => {
      const s = clampText(v, 5)
      return TIME_HM.test(s) ? s : ''
    }),
  from: boundedStr(200),
  to: boundedStr(200),
  confirm: boundedStr(200),
  cost: finiteOrNull.transform((n) => (n != null && n >= 0 ? n : null)),
  currency: boundedStr(8),
  status: z.enum(ITEM_STATUSES).default('planned'),
  notes: boundedStr(5000),
  url: z.unknown().transform((v) => safeHttpsUrl(String(v ?? ''))),
  tags: z
    .array(z.unknown().transform((v) => clampText(v, 40)))
    .max(32)
    .default([]),
  lat: finiteOrNull.transform((n) =>
    n != null && n >= -90 && n <= 90 ? n : null,
  ),
  lon: finiteOrNull.transform((n) =>
    n != null && n >= -180 && n <= 180 ? n : null,
  ),
  latTo: finiteOrNull.transform((n) =>
    n != null && n >= -90 && n <= 90 ? n : null,
  ),
  lonTo: finiteOrNull.transform((n) =>
    n != null && n >= -180 && n <= 180 ? n : null,
  ),
  wikidata: boundedStr(32),
  osmId: boundedStr(64),
  geocodeQuery: boundedStr(300),
  updatedAt: boundedStr(40),
  enrichmentSummary: boundedStr(2000),
  enrichmentImage: z.unknown().transform((v) => safeHttpsUrl(String(v ?? ''))),
  enrichmentSource: boundedStr(80),
  routeCoords: z
    .array(
      z.tuple([
        z.number().finite().min(-90).max(90),
        z.number().finite().min(-180).max(180),
      ]),
    )
    .max(5000)
    .optional()
    .default([]),
  source: z.enum(['excel', 'app', 'enriched', 'example']).default('app'),
})

export const TripRecordSchema = z.object({
  id: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? 'TRIP'), 64))
    .pipe(z.string().min(1).max(64)),
  meta: TripMetaSchema,
  items: z.array(TripItemSchema).max(2000),
  isExample: z.boolean().default(false),
  createdAt: boundedStr(40),
  updatedAt: boundedStr(40),
})

export type TripMeta = z.infer<typeof TripMetaSchema>
export type TripItem = z.infer<typeof TripItemSchema>
export type TripRecord = z.infer<typeof TripRecordSchema>

/** Allowlist parse — drops / clamps invalid fields rather than trusting client shapes. */
export function sanitizeTripRecord(input: unknown): TripRecord {
  const parsed = TripRecordSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Invalid trip data')
  }
  const trip = parsed.data
  if (trip.meta.endDate < trip.meta.startDate) {
    trip.meta.endDate = trip.meta.startDate
  }
  return trip
}

export function sanitizeTripItem(input: unknown): TripItem {
  const parsed = TripItemSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Invalid step data')
  }
  return parsed.data
}

export function sanitizeTripMeta(input: unknown): TripMeta {
  const parsed = TripMetaSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Invalid trip meta')
  }
  const meta = parsed.data
  if (meta.endDate < meta.startDate) meta.endDate = meta.startDate
  return meta
}

export const TYPE_COLORS: Record<ItemType, string> = {
  flight: '#60a5fa',
  train: '#22d3ee',
  bus: '#2dd4bf',
  ferry: '#67e8f9',
  drive: '#fbbf24',
  hotel: '#a78bfa',
  sight: '#34d399',
  restaurant: '#fb923c',
  activity: '#4ade80',
  city: '#f472b6',
  note: '#94a3b8',
  other: '#cbd5e1',
}

export const SCHEDULE_HEADERS = [
  'id',
  'date',
  'end_date',
  'start',
  'end',
  'type',
  'title',
  'place',
  'city',
  'from',
  'to',
  'confirm',
  'cost',
  'currency',
  'status',
  'notes',
  'url',
  'tags',
  'lat',
  'lon',
  'lat_to',
  'lon_to',
  'wikidata',
  'osm_id',
  'geocode_query',
  'updated_at',
] as const
