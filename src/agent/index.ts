export type {
  AgentProduct,
  AreaKnowHow,
  AreaTip,
  Caveat,
  FullTripDayPlan,
  FullTripDraft,
  FullTripHighlight,
  PlaceProvider,
  PlanOptimizeResult,
  PlannerPrefs,
  TripChatModeLabel,
  TripChecklist,
  TripDayBriefing,
  TripDraftDecision,
  TripDraftVersion,
  TripIngestDraftItem,
  TripItemUpdate,
  TripPlannerResult,
  TripSpineOption,
} from './types'

export {
  clearChatSession,
  loadChatSession,
  saveChatSession,
  type StoredChatMessage,
  type TripChatSession,
} from './chatSession'

export {
  formatStructureTime,
  formatTripStructureText,
} from './formatTripStructure'

export {
  groupDayPlan,
  isSpecialDayTheme,
  type StayZoneDay,
  type StayZoneGroup,
} from './groupDayPlan'

export {
  diffTripItems,
  isAiReviewRemoved,
  itemMergeFingerprint,
  mergeReviewDisplayItems,
  summarizeMergeDiff,
  type TripMergeDiff,
} from './tripMergeDiff'

export {
  fingerprintDraft,
  fingerprintLiveTrip,
  liveDayAreas,
  reconcileStructureDrift,
  type StructureDriftResult,
} from './structureDrift'

export {
  clearPlaceProviderCache,
  getCachedPlaceProvider,
  markPlacesUnhealthy,
  placeProviderLabel,
  resolvePlaceProvider,
  setPlaceProvider,
  useGooglePlacesNow,
} from './placeProvider'

export {
  briefingToPlanningHints,
  compileLodgingBrief,
  compileNeighborBrief,
  compileTripDayBriefing,
  mergePlannerPrefs,
  prefsFromMeta,
} from './context/compileDayBriefing'

export {
  applyPlanOptimize,
  classifyPlanPlace,
  optimizeDayRouteSmart,
  optimizePlanDay,
} from './planOptimize'

export {
  applyCoachPlanSeeds,
  optionHasJourneyPatch,
  optionHasPlanSeeds,
  rememberClarification,
  runDayHelper,
} from './dayHelper'

export {
  adaptSegmentToArea,
  allocateSpineToDays,
  applyFullTripDraft,
  applyFullTripDraftWithPlaces,
  applyIngestDraft,
  applyItemUpdates,
  applySpineToTrip,
  composeFullTrip,
  enrichAreaTipSamples,
  existingStepsBrief,
  ingestFreeText,
  requestAreaKnowHow,
  requestAreaTips,
  requestEnrichment,
  requestSpineOptions,
  reshapeTrip,
  suggestDiscoverForAnchor,
} from './tripPlanner'

export {
  applyStayZoneFromTip,
  emptyChecklist,
  greetingForTrip,
  restartConversationForTrip,
  runTripHelper,
  selectSpineDraft,
  type TripHelperCard,
  type TripHelperMessage,
  type TripHelperResult,
} from './tripHelper'

export {
  formatEnrichWhen,
  loadEnrichHistory,
  pushEnrichSnapshot,
  saveEnrichHistory,
  type EnrichFieldUpdate,
  type EnrichSnapshot,
} from './enrichCache'
