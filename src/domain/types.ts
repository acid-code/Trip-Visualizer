import { z } from 'zod'
import { safeHttpsUrl, safeMediaUrl, sanitizeEntityId, clampText } from '../data/security'

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

const PlannerPrefsSchema = z.object({
  vibe: z.array(z.string().max(80)).max(12).optional(),
  pace: z.enum(['soft', 'balanced', 'packed']).optional(),
  food: z.array(z.string().max(80)).max(12).optional(),
  maxWalkKm: z.number().finite().min(0.2).max(10).optional(),
  transport: z.enum(['car', 'transit', 'mixed', 'unknown']).optional(),
  party: z.string().max(200).optional(),
  mustSees: z.array(z.string().max(120)).max(20).optional(),
  avoid: z.array(z.string().max(120)).max(20).optional(),
  notes: z.array(z.string().max(300)).max(24).optional(),
  adoptedAreas: z.array(z.string().max(120)).max(24).optional(),
  structureAppliedAt: z.number().finite().optional(),
  structureFingerprint: z.string().max(500).optional(),
})

export const TripMetaSchema = z.object({
  name: boundedStr(200, 'Untitled trip').pipe(z.string().min(1).max(200)),
  startDate: requiredIsoDate,
  endDate: requiredIsoDate,
  homeCurrency: boundedStr(8, 'EUR').pipe(z.string().min(1).max(8)),
  timezoneNote: boundedStr(200, 'All times are local'),
  travelers: boundedStr(200),
  notes: boundedStr(5000),
  /** Free-text trip mood / what they're looking for — fed to Day Coach & future AI. */
  vibe: boundedStr(2000),
  /** Structured prefs from Trip Planner / Day Helper clarifications. */
  plannerPrefs: PlannerPrefsSchema.optional(),
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
  /** Google/OSM star rating when the step came from Explore / Places (0–5). */
  rating: z
    .union([z.number(), z.null(), z.undefined(), z.nan()])
    .transform((v) => {
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null
      const n = v as number
      if (n < 0 || n > 5) return null
      return Math.round(n * 10) / 10
    })
    .catch(null)
    .default(null),
  /** Canonical Google Maps place URL (reviews) when known. */
  googleMapsUri: z
    .unknown()
    .transform((v) => safeHttpsUrl(String(v ?? '')))
    .catch('')
    .default(''),
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

export const PLAN_SECTION_COLORS = [
  '#60a5fa',
  '#fb923c',
  '#34d399',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#22d3ee',
  '#f87171',
] as const

export const PlanSectionSchema = z.object({
  id: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? 'SEC'), 64))
    .pipe(z.string().min(1).max(64)),
  title: boundedStr(80, 'Ideas').pipe(z.string().min(1).max(80)),
  color: boundedStr(16, '#60a5fa'),
  icon: boundedStr(16, '📍'),
  order: z.number().int().min(0).max(999).default(0),
})

export const PlanPlaceSchema = z.object({
  id: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? 'PP'), 64))
    .pipe(z.string().min(1).max(64)),
  sectionId: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? ''), 64))
    .pipe(z.string().min(1).max(64)),
  name: boundedStr(300, 'Place').pipe(z.string().min(1).max(300)),
  place: boundedStr(500),
  city: boundedStr(120),
  notes: boundedStr(5000),
  lat: finiteOrNull.transform((n) =>
    n != null && n >= -90 && n <= 90 ? n : null,
  ),
  lon: finiteOrNull.transform((n) =>
    n != null && n >= -180 && n <= 180 ? n : null,
  ),
  url: z.unknown().transform((v) => safeHttpsUrl(String(v ?? ''))),
  googleMapsUri: z
    .unknown()
    .transform((v) => safeHttpsUrl(String(v ?? '')))
    .catch('')
    .default(''),
  osmId: boundedStr(64),
  scheduledDay: optionalIsoDate,
  dayOrder: z.number().int().min(0).max(500).nullable().default(null),
  linkedItemId: boundedStr(64),
  /** Snapshot from Explore / Places so detail sheets keep photo · hours · blurb. */
  enrichmentSummary: boundedStr(2000).default(''),
  enrichmentImage: z
    .unknown()
    .transform((v) => safeMediaUrl(String(v ?? '')))
    .default(''),
  images: z
    .array(
      z
        .unknown()
        .transform((v) => safeMediaUrl(String(v ?? '')))
        .pipe(z.string()),
    )
    .max(6)
    .optional()
    .default([]),
  openingHours: boundedStr(800).default(''),
  openingPeriods: z
    .array(
      z.object({
        open: z.object({
          day: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
        }),
        close: z
          .object({
            day: z.number().int().min(0).max(6),
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59),
          })
          .optional(),
      }),
    )
    .max(28)
    .optional()
    .default([]),
  rating: z
    .union([z.number(), z.null(), z.undefined(), z.nan()])
    .transform((v) => {
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null
      const n = v as number
      if (n < 0 || n > 5) return null
      return Math.round(n * 10) / 10
    })
    .catch(null)
    .default(null),
  cuisine: boundedStr(120).default(''),
  /** Google photo resource names are long (~260–400 chars); do not truncate. */
  googlePhotoName: boundedStr(1024).default(''),
})

/** Whole Trip AI sketch tip — rides share sync; chat transcripts stay local. */
const AiSketchTransportHintSchema = z.enum([
  'walk_city',
  'transit_ok',
  'car_useful',
  'car_needed',
])

const AiSketchDayPlanSchema = z.object({
  date: requiredIsoDate,
  areaLabel: boundedStr(120),
  theme: boundedStr(200),
  why: boundedStr(400).optional(),
  special: z.boolean().optional(),
  highlights: z
    .array(
      z.object({
        name: boundedStr(200),
        why: boundedStr(300),
      }),
    )
    .max(12)
    .default([]),
})

const AiSketchDraftSchema = z.object({
  summary: boundedStr(800),
  titleSuggestion: boundedStr(200).optional(),
  spine: z.object({
    id: boundedStr(64),
    label: boundedStr(120),
    summary: boundedStr(500),
    why: boundedStr(500).optional(),
    areas: z
      .array(
        z.object({
          label: boundedStr(120),
          roughNights: z.number().int().min(0).max(40),
          transportHint: AiSketchTransportHintSchema.catch('transit_ok'),
          theme: boundedStr(200).optional(),
          why: boundedStr(400).optional(),
        }),
      )
      .max(20),
    openQuestions: z.array(boundedStr(300)).max(12).default([]),
  }),
  dayPlan: z.array(AiSketchDayPlanSchema).max(60).default([]),
  planPlaceNames: z
    .array(
      z.object({
        name: boundedStr(200),
        section: z.enum(['must', 'food', 'maybe']).catch('maybe'),
        city: boundedStr(120).optional(),
        why: boundedStr(300).optional(),
      }),
    )
    .max(40)
    .default([]),
  items: z
    .array(
      z.object({
        type: boundedStr(40),
        title: boundedStr(300),
        place: boundedStr(500).optional().default(''),
        city: boundedStr(120).optional().default(''),
        date: optionalIsoDate,
        endDate: optionalIsoDate.optional(),
        start: boundedStr(5).optional(),
        end: boundedStr(5).optional(),
        from: boundedStr(200).optional(),
        to: boundedStr(200).optional(),
        notes: boundedStr(500).optional(),
        confidence: z.enum(['high', 'medium', 'low']).catch('medium'),
        source: z
          .enum(['user_text', 'inferred', 'web'])
          .catch('inferred'),
        tentative: z.boolean().optional(),
      }),
    )
    .max(40)
    .default([]),
  itemUpdates: z
    .array(
      z.object({
        itemId: boundedStr(64),
        title: boundedStr(300).optional(),
        start: boundedStr(5).optional(),
        end: boundedStr(5).optional(),
        from: boundedStr(200).optional(),
        to: boundedStr(200).optional(),
        date: optionalIsoDate.optional(),
        endDate: optionalIsoDate.optional(),
        notes: boundedStr(500).optional(),
        place: boundedStr(500).optional(),
        city: boundedStr(120).optional(),
      }),
    )
    .max(40)
    .optional(),
  openQuestions: z.array(boundedStr(300)).max(12).default([]),
  droppedHighlights: z.array(boundedStr(200)).max(40).optional(),
  removeItemIds: z.array(boundedStr(64)).max(40).optional(),
  pendingRemovals: z
    .array(
      z.object({
        itemId: boundedStr(64),
        title: boundedStr(200),
        reason: boundedStr(300),
      }),
    )
    .max(20)
    .optional(),
  decisions: z
    .array(
      z.object({
        what: boundedStr(120),
        why: boundedStr(400),
      }),
    )
    .max(16)
    .optional(),
  prefs: PlannerPrefsSchema.optional(),
})

export const AiSketchSchema = z.object({
  versions: z
    .array(
      z.object({
        id: boundedStr(64),
        at: z.number().finite(),
        label: boundedStr(80),
        reason: boundedStr(240),
        mode: boundedStr(40),
        draft: AiSketchDraftSchema,
        byUid: boundedStr(128).optional(),
        byLabel: boundedStr(120).optional(),
        byEmail: boundedStr(320).optional(),
      }),
    )
    .max(6)
    .default([]),
  index: z.number().int().min(-1).max(5).default(-1),
  updatedAt: z.number().finite().optional(),
})

export const TripRecordSchema = z.object({
  id: z
    .unknown()
    .transform((v) => sanitizeEntityId(String(v ?? 'TRIP'), 64))
    .pipe(z.string().min(1).max(64)),
  meta: TripMetaSchema,
  items: z.array(TripItemSchema).max(2000),
  planSections: z.array(PlanSectionSchema).max(40).optional().default([]),
  planPlaces: z.array(PlanPlaceSchema).max(2000).optional().default([]),
  isExample: z.boolean().default(false),
  createdAt: boundedStr(40),
  updatedAt: boundedStr(40),
  /** When set with shareEnabled, trip syncs via Firestore. */
  cloudTripId: boundedStr(64).optional(),
  shareEnabled: z.boolean().optional(),
  shareOwnerUid: boundedStr(128).optional(),
  shareOwnerEmail: boundedStr(320).optional(),
  revision: z.number().int().min(0).max(1_000_000_000).optional(),
  /**
   * Whole Trip AI sketch versions (structure only). Syncs with share.
   * Chat transcripts are intentionally NOT stored here — device-local only.
   */
  aiSketch: AiSketchSchema.optional(),
})

export type TripMeta = z.infer<typeof TripMetaSchema>
export type TripItem = z.infer<typeof TripItemSchema>
export type PlanSection = z.infer<typeof PlanSectionSchema>
export type PlanPlace = z.infer<typeof PlanPlaceSchema>
export type TripRecord = z.infer<typeof TripRecordSchema>
export type AiSketch = z.infer<typeof AiSketchSchema>

/** Defaults for PlanPlace enrichment snapshot fields (tests + hand-built places). */
export function blankPlanPlaceEnrichment(): Pick<
  PlanPlace,
  | 'enrichmentSummary'
  | 'enrichmentImage'
  | 'images'
  | 'openingHours'
  | 'openingPeriods'
  | 'rating'
  | 'cuisine'
  | 'googlePhotoName'
> {
  return {
    enrichmentSummary: '',
    enrichmentImage: '',
    images: [],
    openingHours: '',
    openingPeriods: [],
    rating: null,
    cuisine: '',
    googlePhotoName: '',
  }
}

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

export const TYPE_EMOJI: Record<ItemType, string> = {
  flight: '✈️',
  train: '🚆',
  bus: '🚌',
  ferry: '⛴️',
  drive: '🚗',
  hotel: '🛏️',
  sight: '🏛️',
  restaurant: '🍽️',
  activity: '🎟️',
  city: '🏙️',
  note: '📝',
  other: '✨',
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
