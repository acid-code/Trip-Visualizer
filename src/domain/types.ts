import { z } from 'zod'

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

export const TripMetaSchema = z.object({
  name: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  homeCurrency: z.string().default('EUR'),
  timezoneNote: z.string().default('All times are local'),
  travelers: z.string().default(''),
  notes: z.string().default(''),
})

export const TripItemSchema = z.object({
  id: z.string(),
  type: z.enum(ITEM_TYPES),
  title: z.string().min(1),
  place: z.string().optional().default(''),
  city: z.string().optional().default(''),
  date: z.string(),
  endDate: z.string().optional().default(''),
  start: z.string().optional().default(''),
  end: z.string().optional().default(''),
  from: z.string().optional().default(''),
  to: z.string().optional().default(''),
  confirm: z.string().optional().default(''),
  cost: z.number().nullable().optional().default(null),
  currency: z.string().optional().default(''),
  status: z.enum(ITEM_STATUSES).default('planned'),
  notes: z.string().optional().default(''),
  url: z.string().optional().default(''),
  tags: z.array(z.string()).default([]),
  lat: z.number().nullable().optional().default(null),
  lon: z.number().nullable().optional().default(null),
  latTo: z.number().nullable().optional().default(null),
  lonTo: z.number().nullable().optional().default(null),
  wikidata: z.string().optional().default(''),
  osmId: z.string().optional().default(''),
  geocodeQuery: z.string().optional().default(''),
  updatedAt: z.string().optional().default(''),
  enrichmentSummary: z.string().optional().default(''),
  enrichmentImage: z.string().optional().default(''),
  enrichmentSource: z.string().optional().default(''),
  routeCoords: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .default([]),
  source: z.enum(['excel', 'app', 'enriched', 'example']).default('app'),
})

export type TripMeta = z.infer<typeof TripMetaSchema>
export type TripItem = z.infer<typeof TripItemSchema>

export type TripRecord = {
  id: string
  meta: TripMeta
  items: TripItem[]
  isExample: boolean
  createdAt: string
  updatedAt: string
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
