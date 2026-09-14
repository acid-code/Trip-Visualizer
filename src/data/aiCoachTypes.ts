import type { ExploreCategory } from './explore'

export type AiCoachOptionKind =
  | 'food'
  | 'highlight'
  | 'viewpoint'
  | 'pacing'
  | 'itinerary'
  | 'trim'
  | 'other'

export type AiCoachPatchAddStep = {
  candidateId: string
  start?: string
  end?: string
  note?: string
}

export type AiCoachPatchSetTime = {
  itemId: string
  start?: string
  end?: string
}

export type AiCoachPatchRemoveStep = {
  itemId: string
}

/** Drive from an existing day step (or day anchor) to a grounded candidate. */
export type AiCoachPatchAddDrive = {
  /** Existing day item to depart from (dealership, hotel, arrival). */
  fromItemId?: string
  /** Previous stop added in this same patch (candidate id) — for chained day trips. */
  fromCandidateId?: string
  toCandidateId: string
  start?: string
  end?: string
}

export type AiCoachPatch = {
  addSteps?: AiCoachPatchAddStep[]
  addDrives?: AiCoachPatchAddDrive[]
  setTimes?: AiCoachPatchSetTime[]
  removeSteps?: AiCoachPatchRemoveStep[]
  addNote?: { title: string; notes: string; start?: string }
}

export type AiCoachOption = {
  id: string
  label: string
  kind: AiCoachOptionKind
  summary: string
  rationale: string
  patch: AiCoachPatch
}

export type AiCoachCandidateRole =
  | 'near_start'
  | 'destination'
  | 'along_route'
  | 'meal'
  | 'viewpoint'

export type AiCoachCandidate = {
  id: string
  name: string
  category: ExploreCategory
  lat: number
  lon: number
  distKm: number
  rating: number | null
  summary: string
  address: string
  cuisine: string
  role?: AiCoachCandidateRole
  regionLabel?: string
  /** Human hours text when known. */
  openingHours?: string
  /** Compact open-slot hint for the coached day (e.g. "open ~ 09:00, 13:00"). */
  openHint?: string
}

export type AiCoachDayItem = {
  id: string
  type: string
  title: string
  place: string
  date: string
  endDate?: string
  start: string
  end: string
  lat: number | null
  lon: number | null
  latTo: number | null
  lonTo: number | null
  isPlaceholder: boolean
  /** Likely car pickup / dealership / rental desk */
  isVehicleStop?: boolean
  /** Safe for removeSteps (not flight/hotel/vehicle/placeholder). */
  canRemove?: boolean
}

export type AiCoachRequestBody = {
  day: string
  userMessage: string
  clarifications: string[]
  tripName: string
  travelers: string
  notes: string
  thinDay: boolean
  /** How packed the coached day already is. */
  dayFillLevel?: 'empty' | 'partial' | 'full'
  anchor: { lat: number; lon: number; label: string } | null
  dayItems: AiCoachDayItem[]
  candidates: AiCoachCandidate[]
  /**
   * Transit gate for this day (flight/train/bus/ferry arrival).
   * Coach must not schedule new stops before earliestStart; skip fills when inTransitAllDay.
   */
  dayAvailability?: {
    earliestStart: string | null
    inTransitAllDay: boolean
    notes: string[]
  }
  /** Soft planning hints for the model (meal gaps, drive intent, etc.). */
  planningHints?: string[]
  /**
   * Deterministic critique from a prior propose pass.
   * When set, the model should revise and fix these issues (second loop only).
   */
  critiqueFeedback?: string[]
}

export type AiCoachApiResponse =
  | { kind: 'need_clarification'; question: string }
  | { kind: 'options'; options: AiCoachOption[] }

export type AiChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
  /** When true, reveal with typewriter */
  animate?: boolean
}
