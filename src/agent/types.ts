/** Shared types for Plan Optimizer, Day Helper, and Trip Planner agents. */

export type PlaceProvider = 'google' | 'osm'

export type AgentProduct =
  | 'plan_optimize'
  | 'journey_day'
  | 'trip_planner'

export type AgentPace = 'soft' | 'balanced' | 'packed' | 'unknown'

export type TransportHint =
  | 'walk_city'
  | 'transit_ok'
  | 'car_useful'
  | 'car_needed'

export type PlannerPrefs = {
  vibe?: string[]
  pace?: Exclude<AgentPace, 'unknown'>
  food?: string[]
  maxWalkKm?: number
  transport?: 'car' | 'transit' | 'mixed' | 'unknown'
  party?: string
  mustSees?: string[]
  avoid?: string[]
  /** Free-form answers from clarifications / interview. */
  notes?: string[]
  /** Adopted area / neighborhood labels for this trip. */
  adoptedAreas?: string[]
  /** When a Whole Trip structure was last applied to the Journey. */
  structureAppliedAt?: number
  /** Fingerprint of live trip structure at last apply (drift detection). */
  structureFingerprint?: string
}

export type AreaNeighborhood = {
  label: string
  vibeTags: string[]
  nightWalk?: boolean
  budgetFit?: string
  whyStayHere: string
  anchorLat: number | null
  anchorLon: number | null
  samplePlaceIds: string[]
}

export type AreaTip = {
  id: string
  areaLabel: string
  country: string
  vibeTags: string[]
  whyGo: string
  roughNights: number
  transportHint: TransportHint
  neighborhoods: AreaNeighborhood[]
  caveatsLite: string[]
}

export type Caveat = {
  severity: 'info' | 'warn' | 'dealbreaker'
  topic: string
  summary: string
  appliesTo: 'area' | 'hotel' | 'day' | 'leg' | 'trip'
  source: 'web' | 'model' | 'user'
}

export type LodgingBrief = {
  tonight: {
    title: string
    place: string
    lat: number | null
    lon: number | null
    checkIn: string
    checkOut: string
  } | null
  morningBase:
    | 'same_hotel'
    | 'check_in_today'
    | 'placeholder'
    | 'transit_arrival'
    | 'unknown'
  checkoutToday: boolean
  nextNightDifferent: boolean
}

export type NeighborDayBrief = {
  date: string
  summary: string
  eveningStops: string[]
  morningStops: string[]
  sleepAt: string
}

export type TripDayBriefing = {
  day: string
  lodging: LodgingBrief
  neighbors: {
    yesterday: NeighborDayBrief | null
    tomorrow: NeighborDayBrief | null
  }
  areaContext: {
    label: string
    kind: 'neighborhood' | 'district' | 'region' | 'unknown'
    vibeTags: string[]
    notes: string
  } | null
  tripMemory: {
    avoidedPlaces: string[]
    userPrefs: string[]
    pace: AgentPace
  }
  caveats: Caveat[]
  placeProvider: PlaceProvider
}

export type PlanOptimizeResult = {
  kind: 'reorder'
  day: string
  orderedIds: string[]
  summary: string
  pace: 'easy' | 'packed'
  alternatives?: Array<{
    pace: 'easy' | 'packed'
    orderedIds: string[]
    summary: string
  }>
}

export type TripSpineOption = {
  id: string
  label: string
  summary: string
  /** Why this spine fits the user’s vibe / existing flights. */
  why?: string
  areas: Array<{
    label: string
    roughNights: number
    transportHint: TransportHint
    theme?: string
    why?: string
  }>
  openQuestions: string[]
}

export type TripIngestDraftItem = {
  type: string
  title: string
  place: string
  city: string
  date: string
  endDate?: string
  start?: string
  end?: string
  from?: string
  to?: string
  notes?: string
  confidence: 'high' | 'medium' | 'low'
  source: 'user_text' | 'inferred' | 'web'
  tentative?: boolean
}

/** One calendar day in a model-composed full trip (areas only — no hotels). */
export type FullTripHighlight = {
  name: string
  /** Plain-language why this fits the user / day / flight timing. */
  why: string
}

export type FullTripDayPlan = {
  date: string
  areaLabel: string
  theme: string
  /** Why this area/theme for this day (seen by user). */
  why?: string
  highlights: FullTripHighlight[]
  /**
   * True when this calendar day is a named celebration the user called out
   * (birthday, anniversary, …) — must stay visible in the shape tree.
   */
  special?: boolean
}

/** Human-readable decision the coach made — shown so the user feels seen. */
export type TripDraftDecision = {
  what: string
  why: string
}

export type FullTripDraft = {
  summary: string
  titleSuggestion?: string
  spine: TripSpineOption
  dayPlan: FullTripDayPlan[]
  planPlaceNames: Array<{
    name: string
    section: 'must' | 'food' | 'maybe'
    city?: string
    why?: string
  }>
  /** Transit / sights / notes only — hotels are stripped on apply. */
  items: TripIngestDraftItem[]
  /** Patch existing Journey steps (esp. flights) in place. */
  itemUpdates?: TripItemUpdate[]
  prefs?: Partial<PlannerPrefs>
  openQuestions: string[]
  /** Highlights dropped by user in the shape tree (not materialized). */
  droppedHighlights?: string[]
  /**
   * Explicit “why we added / changed this” list for the shape panel & chat.
   * Should reference existing flights, vibe, dates when relevant.
   */
  decisions?: TripDraftDecision[]
}

/** In-place update for an existing trip item (match by itemId). */
export type TripItemUpdate = {
  itemId: string
  title?: string
  start?: string
  end?: string
  from?: string
  to?: string
  date?: string
  endDate?: string
  notes?: string
  place?: string
  city?: string
}

export type TripChatToolName =
  | 'compose_full_trip'
  | 'propose_spines'
  | 'area_tips'
  | 'set_stay_zone'
  | 'enrich'
  | 'area_knowhow'
  | 'mirror_journey'
  | 'reshape'
  | 'update_items'

export type TripChatModeLabel =
  | 'Listening'
  | 'Sketching a route'
  | 'Comparing stay zones'
  | 'Filling flight details'
  | 'Gathering must-knows'
  | 'Reshaping the trip'
  | 'Ready to apply'

/** Per-area briefing so the user feels ready (hotel zones, vibe fit — no hotel names). */
export type AreaKnowHow = {
  areaLabel: string
  /** How this area matches their vibe / trip goals. */
  vibeFit: string
  /** Neighborhoods that are strong bases for lodging search (never invent hotel brands). */
  hotelZones: Array<{
    label: string
    why: string
    forVibes: string[]
  }>
  /** Honest tradeoffs / who it is less good for. */
  tradeoffs?: string
  /** Practical readiness tips (transit, walking at night, booking timing). */
  readyTips: string[]
}

export type TripChatTurnResult =
  | {
      kind: 'reply'
      message: string
      modeLabel: TripChatModeLabel
      reason: string
      checklist?: Partial<TripChecklist>
    }
  | {
      kind: 'tool'
      tool: TripChatToolName
      args: Record<string, unknown>
      modeLabel: TripChatModeLabel
      reason: string
      message?: string
    }
  | {
      kind: 'draft'
      message: string
      modeLabel: TripChatModeLabel
      reason: string
      draft: FullTripDraft
      checklist?: Partial<TripChecklist>
    }

export type TripChecklist = {
  vibe: boolean
  route: boolean
  stayZones: boolean
  details: boolean
  ready: boolean
}

export type TripDraftVersion = {
  id: string
  at: number
  label: string
  reason: string
  mode: TripChatModeLabel
  draft: FullTripDraft
  /** Who sketched this tip (for shared trips). */
  byUid?: string
  /** Short display label: name or email. */
  byLabel?: string
  byEmail?: string
}

export type TripPlannerResult =
  | {
      kind: 'need_clarification'
      question: string
    }
  | {
      kind: 'spine_options'
      options: TripSpineOption[]
      prefs?: Partial<PlannerPrefs>
      areaTips?: AreaTip[]
    }
  | {
      kind: 'area_tips'
      tips: AreaTip[]
    }
  | {
      kind: 'ingest_draft'
      items: TripIngestDraftItem[]
      planPlaceNames: Array<{ name: string; section: 'must' | 'food' | 'maybe'; city?: string }>
      prefs?: Partial<PlannerPrefs>
      openQuestions: string[]
      spineOptions?: TripSpineOption[]
    }
  | {
      kind: 'full_trip'
      draft: FullTripDraft
    }
  | {
      kind: 'adapt'
      summary: string
      dropAreaLabels: string[]
      adoptArea: AreaTip
      prefs?: Partial<PlannerPrefs>
    }
  | {
      kind: 'enrich'
      fieldUpdates: Array<{
        itemTitle: string
        field: string
        value: string
        confidence: 'high' | 'medium' | 'low'
        source: 'web' | 'model'
        citation?: string
      }>
      caveats: Caveat[]
    }
  | {
      kind: 'area_knowhow'
      areas: AreaKnowHow[]
      summary: string
    }
  | {
      kind: 'reshape'
      summary: string
      prefs?: Partial<PlannerPrefs>
      areaTips?: AreaTip[]
      spineOptions?: TripSpineOption[]
      openQuestions: string[]
    }
