import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TripItem, TripRecord } from './domain/types'
import { ITEM_TYPES } from './domain/types'
import {
  createBlankTrip,
  createId,
  deleteTrip,
  ensureExampleTrip,
  getSetting,
  getTrip,
  listTrips,
  nowIso,
  saveTrip,
  setSetting,
  sortItems,
} from './data/db'
import {
  buildTripWorkbook,
  downloadWorkbook,
  parseTripWorkbook,
  workbookToArrayBuffer,
} from './data/excel'
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  downloadDriveFile,
  driveFileWebUrl,
  DRIVE_FOLDER_NAME,
  isGoogleDriveConfigured,
  isGoogleDriveConnected,
  listTripWorkbooksOnDrive,
  rememberDriveFileForTrip,
  forgetDriveFileForTrip,
  resolveDriveFolderOpenUrl,
  slugTripFileBase,
  tripNameSlugFromDriveFileName,
  uploadTripWorkbookToDrive,
  type DriveFileInfo,
} from './data/googleDrive'
import {
  enrichNeedyTripItems,
  extractCoordsFromText,
  itemNeedsEnrich,
  locationQueryFromInput,
  lookupPlace,
  pinItemOnMap,
  pinTripItemsOnMap,
  reverseGeocode,
  type PlaceLookup,
} from './data/enrichment'
import {
  buildWalkingConnectors,
  hydrateDriveRoutes,
  nearbyWalkLinks,
  suggestDateFromNearby,
  type NearbyStepLink,
  type RouteConnector,
} from './data/routes'
import {
  isWalkAppPref,
  openExternalUrl,
  openWalkTarget,
  travelModeForLeg,
  type MapsTravelMode,
  type WalkAppPref,
  type WalkLinkTarget,
} from './data/mapsLinks'
import { GlobeView, type MapSelectPayload } from './ui/GlobeView'
import { TimelinePanel } from './ui/TimelinePanel'
import { ChartsPanel } from './ui/ChartsPanel'
import { ItemDrawer } from './ui/ItemDrawer'
import { AddStepPanel, type AddContext } from './ui/AddStepPanel'
import { MapSearchBar } from './ui/MapSearchBar'
import { ExploreSheet } from './ui/ExploreSheet'
import {
  AiCoachSheet,
  AiSparkIcon,
  AI_COACH_BETA_TIP,
  type AiCoachSessionRestore,
} from './ui/AiCoachSheet'
import { AiReviewChrome } from './ui/AiReviewChrome'
import { SegmentedControl } from './ui/primitives'
import { PlanBoard, applyLocalPlanAi } from './ui/PlanBoard'
import { MapLayersControl } from './ui/MapLayersControl'
import { JOURNEY_TONGUES, JourneyBookDock } from './ui/JourneyBookDock'
import { ensurePlanScaffold } from './data/planBoard'
import {
  applyColorMode,
  DEFAULT_COLOR_MODE,
  isColorMode,
  type ColorMode,
} from './data/theme'
import { formatDayChipLabel } from './data/aiCoach'
import {
  applyCoachPatch,
  assertOtherDaysIntact,
  earliestNewSpot,
  newSpotsForOverview,
} from './data/aiCoachPatch'
import type { AiCoachOption } from './data/aiCoachTypes'
import { FeatureGuide } from './ui/FeatureGuide'
import {
  explorePlaceToItemType,
  explorePlaceTripMeta,
  fetchNearbyExplore,
  type ExplorePlace,
} from './data/explore'
import { hydrateGooglePlacePhoto } from './data/placesGoogle'
import {
  FEATURE_TIPS,
  parseSeenTipIds,
  serializeSeenTipIds,
  unseenFeatureTips,
  type FeatureTip,
} from './data/featureGuide'
import {
  DEFAULT_MAP_LOOK,
  DEFAULT_MAP_STACK,
  resolveMapStack,
  type MapLook,
  type MapStack,
} from './globe/viewer'
import { firstOpenableStep } from './globe/viewer'
import { EXAMPLE_TRIP_ID, exampleItems, exampleMeta } from './data/examples/france-south-loop'
import { ensureDayStartBases, deleteStepAndPrune, isPlaceholderBase, itemTouchesDay, applyTripMetaRange, countTripDays, widenMetaToItems } from './data/dayBases'
import { clearTypeSwitchMemory } from './data/typeSwitch'
import { normalizeCurrency } from './data/fx'
import {
  isValidCoord,
  requireIsoDate,
  sanitizeMetaDates,
  todayIso,
} from './data/validate'
import {
  logClientError,
  MAX_IMPORT_BYTES,
  publicErrorMessage,
  sanitizeSecretInput,
} from './data/security'
import { resolveGoogleMapsApiKey } from './data/googleKey'
import {
  clearClientLogs,
  formatClientLogsText,
  getClientLogsSnapshot,
  logClientInfo,
  subscribeClientLogs,
} from './data/clientLogs'
import { forceAppRefresh } from './updateCheck'
import { sanitizeTripRecord } from './domain/types'
import { useIsNarrow } from './ui/useIsNarrow'
import {
  TripMetaDialog,
  defaultCreateDraft,
  draftFromMeta,
  type TripMetaDraft,
} from './ui/TripMetaDialog'
import { TripSwitcher } from './ui/TripSwitcher'
import { TripStartCoach } from './ui/TripStartCoach'
import type { RangeReconcileMode } from './data/dayBases'

type NavTab = 'timeline' | 'charts' | 'settings'
type LowerMode = 'none' | 'detail' | 'insert'

function cloneTripItem(item: TripItem): TripItem {
  return {
    ...item,
    tags: [...(item.tags ?? [])],
    routeCoords: item.routeCoords
      ? item.routeCoords.map((c) => [c[0], c[1]] as [number, number])
      : [],
  }
}

type AiReviewState = {
  beforeItems: TripItem[]
  draftItems: TripItem[]
  optionId: string
  day: string
  session: AiCoachSessionRestore
  addedIds: string[]
  error: string | null
}

export default function App() {
  const isPhone = useIsNarrow()
  const [trips, setTrips] = useState<TripRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [navTab, setNavTab] = useState<NavTab>('timeline')
  const [panelOpen, setPanelOpen] = useState(true)
  const [lowerMode, setLowerMode] = useState<LowerMode>('none')
  /** Detail sheet: peek (compact) → half (50% edit) → closed */
  const [detailExpanded, setDetailExpanded] = useState(false)
  /** Working copy while Detail is open — committed only via top handle save. */
  const [stepDraft, setStepDraft] = useState<TripItem | null>(null)
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [mapStack, setMapStack] = useState<MapStack>(DEFAULT_MAP_STACK)
  const [mapLook, setMapLook] = useState<MapLook>(DEFAULT_MAP_LOOK)
  const [colorMode, setColorMode] = useState<ColorMode>(DEFAULT_COLOR_MODE)
  const [appMode, setAppMode] = useState<'journey' | 'plan'>('journey')
  const [googleKey, setGoogleKey] = useState('')
  const [ionToken, setIonToken] = useState('')
  /** Data-panel override only — deploy key stays on the server. */
  const effectiveGoogleKey = resolveGoogleMapsApiKey(googleKey)
  const [serverPlacesConfigured, setServerPlacesConfigured] = useState(false)
  const placesEnabled = Boolean(effectiveGoogleKey) || serverPlacesConfigured
  const effectiveMapStack = useMemo(
    () => resolveMapStack(mapLook, mapStack),
    [mapLook, mapStack],
  )
  const [walkApp, setWalkApp] = useState<WalkAppPref>('maps')
  const [status, setStatus] = useState('')
  const [overviewToken, setOverviewToken] = useState(0)
  const [subsetFitToken, setSubsetFitToken] = useState(0)
  const [subsetFitItems, setSubsetFitItems] = useState<TripItem[]>([])
  const [enrichProgress, setEnrichProgress] = useState<string | null>(null)
  const [connectors, setConnectors] = useState<RouteConnector[]>([])
  const [routesStatus, setRoutesStatus] = useState<string | null>(null)
  const [addContext, setAddContext] = useState<AddContext | null>(null)
  const [tempPin, setTempPin] = useState<{
    lat: number
    lon: number
    label?: string
    place?: string
    address?: string
    city?: string
    osmId?: string
    query?: string
    loading?: boolean
  } | null>(null)
  const [nearbyLinks, setNearbyLinks] = useState<NearbyStepLink[]>([])
  const [tempFlyToken, setTempFlyToken] = useState(0)
  const [searchBusy, setSearchBusy] = useState(false)
  const [mapFocusEndpoint, setMapFocusEndpoint] = useState<'a' | 'b' | null>(null)
  const [routeWalk, setRouteWalk] = useState<
    | {
        kind: 'route'
        origin: { lat: number; lon: number }
        destination: { lat: number; lon: number }
        travelMode: MapsTravelMode
        coords: [number, number][]
      }
    | {
        kind: 'flights'
        from: string
        to: string
        date: string
        origin: { lat: number; lon: number }
        destination: { lat: number; lon: number }
        coords: [number, number][]
      }
    | null
  >(null)
  const [exploreOpen, setExploreOpen] = useState(false)
  const [exploreAnchor, setExploreAnchor] = useState<{
    lat: number
    lon: number
    label: string
    date: string
    stepId?: string
  } | null>(null)
  const [explorePlaces, setExplorePlaces] = useState<ExplorePlace[]>([])
  const [exploreBusy, setExploreBusy] = useState(false)
  const [exploreError, setExploreError] = useState<string | null>(null)
  const [exploreFocusId, setExploreFocusId] = useState<string | null>(null)
  const [exploreDetail, setExploreDetail] = useState<ExplorePlace | null>(null)
  const [exploreFlyToken, setExploreFlyToken] = useState(0)
  const [exploreReturnToken, setExploreReturnToken] = useState(0)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiRestore, setAiRestore] = useState<AiCoachSessionRestore | null>(null)
  const [aiReview, setAiReview] = useState<AiReviewState | null>(null)
  const [aiReviewBusy, setAiReviewBusy] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideTips, setGuideTips] = useState<FeatureTip[]>([])
  const [seenTipIds, setSeenTipIds] = useState<Set<string>>(() => new Set())
  const [tripDialog, setTripDialog] = useState<null | { mode: 'create' | 'edit'; draft: TripMetaDraft }>(
    null,
  )
  const [startCoachOpen, setStartCoachOpen] = useState(false)
  const guideAutoShownRef = useRef(false)
  /** When true, keep the example trip alongside personal trips (user opened it explicitly). */
  const keepExampleRef = useRef(false)
  const routesForTripRef = useRef<string | null>(null)
  const routesBuildingRef = useRef(false)
  const enrichBusyRef = useRef(false)
  const enrichAttemptedRef = useRef<Set<string>>(new Set())
  const tempPinGenRef = useRef(0)
  const exploreAbortRef = useRef<AbortController | null>(null)

  const active = useMemo(
    () => trips.find((t) => t.id === activeId) ?? null,
    [trips, activeId],
  )

  /** Live trip view — draft items while AI review is open. */
  const displayTrip = useMemo(() => {
    if (!active) return null
    if (!aiReview) return active
    return { ...active, items: aiReview.draftItems }
  }, [active, aiReview])

  const selected = useMemo(
    () => displayTrip?.items.find((i) => i.id === selectedId) ?? null,
    [displayTrip, selectedId],
  )
  /** Item shown in the detail editor (draft while editing). */
  const detailItem = stepDraft?.id === selectedId ? stepDraft : selected

  const refresh = useCallback(async () => {
    let all = await listTrips()
    const hasPersonal = all.some((t) => !t.isExample && t.id !== EXAMPLE_TRIP_ID)
    if (hasPersonal && !keepExampleRef.current) {
      const hadExample = all.some((t) => t.isExample || t.id === EXAMPLE_TRIP_ID)
      if (hadExample) {
        await deleteTrip(EXAMPLE_TRIP_ID)
        all = await listTrips()
      }
    }
    setTrips(all)
    // Prefer the latest personal / WIP trip; fall back to the example only if nothing else
    setActiveId(
      (prev) =>
        prev ??
        all.find((t) => !t.isExample && t.id !== EXAMPLE_TRIP_ID)?.id ??
        all.find((t) => t.isExample || t.id === EXAMPLE_TRIP_ID)?.id ??
        all[0]?.id ??
        null,
    )
  }, [])

  async function retireExampleTrip() {
    keepExampleRef.current = false
    await deleteTrip(EXAMPLE_TRIP_ID)
  }

  useEffect(() => {
    void (async () => {
      await refresh()
      setGoogleKey((await getSetting('googleMapsKey')) ?? '')
      setIonToken((await getSetting('cesiumIonToken')) ?? '')
      const savedStack = (await getSetting('mapStack')) as MapStack | undefined
      setMapStack(
        savedStack === 'osm' || savedStack === 'esri' || savedStack === 'google3d'
          ? savedStack
          : DEFAULT_MAP_STACK,
      )
      const savedLook = (await getSetting('mapLook')) as MapLook | undefined
      setMapLook(savedLook === 'modern' ? 'modern' : DEFAULT_MAP_LOOK)
      const savedColor = await getSetting('colorMode')
      const mode = isColorMode(savedColor) ? savedColor : DEFAULT_COLOR_MODE
      setColorMode(mode)
      applyColorMode(mode)
      const savedMode = await getSetting('appMode')
      setAppMode(savedMode === 'plan' ? 'plan' : 'journey')
      const walkPref = await getSetting('walkApp')
      setWalkApp(isWalkAppPref(walkPref) ? walkPref : 'maps')
      const seen = parseSeenTipIds(await getSetting('featureGuideSeen'))
      setSeenTipIds(seen)
      const unseen = unseenFeatureTips(seen)
      if (unseen.length && !guideAutoShownRef.current) {
        guideAutoShownRef.current = true
        setGuideTips(unseen)
        setGuideOpen(true)
      }
    })()
  }, [refresh])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/maps-status', { cache: 'no-store' })
        if (!res.ok) {
          logClientError('maps-status', `HTTP ${res.status}`)
          setServerPlacesConfigured(false)
          return
        }
        const data = (await res.json()) as { placesConfigured?: boolean }
        const ok = Boolean(data.placesConfigured)
        setServerPlacesConfigured(ok)
        logClientInfo(
          'maps-status',
          ok
            ? 'Server GOOGLE_MAPS_API_KEY is configured — Explore will use Google Places'
            : 'No server GOOGLE_MAPS_API_KEY — Explore uses OSM unless you paste a key in Settings',
        )
      } catch (err) {
        setServerPlacesConfigured(false)
        logClientError('maps-status', err)
      }
    })()
  }, [])

  async function markTipsSeen(ids: string[]) {
    if (!ids.length) return
    setSeenTipIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      void setSetting('featureGuideSeen', serializeSeenTipIds(next))
      return next
    })
  }

  function openFeatureGuide(opts?: { all?: boolean }) {
    const tips = opts?.all ? FEATURE_TIPS : unseenFeatureTips(seenTipIds)
    const deck = tips.length ? tips : FEATURE_TIPS
    setGuideTips(deck)
    setGuideOpen(true)
  }

  // When a trip becomes active, highlight its first step (camera uses opening framing)
  useEffect(() => {
    if (!activeId || !active) return
    const first = firstOpenableStep(active.items)
    setSelectedId(first?.id ?? null)
    // Phone + first flight: focus departure pin (leg A), not the whole arc
    setMapFocusEndpoint(
      isPhone && first?.type === 'flight' && isValidCoord(first.lat, first.lon)
        ? 'a'
        : null,
    )
    setRouteWalk(null)
    setLowerMode('none')
    setDetailExpanded(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when switching trips
  }, [activeId])

  async function persist(next: TripRecord) {
    const withPlan = ensurePlanScaffold(next)
    const meta = widenMetaToItems(withPlan.meta, withPlan.items)
    const items = ensureDayStartBases(meta, withPlan.items)
    await saveTrip({ ...withPlan, meta, items })
    setTrips(await listTrips())
  }

  async function updateActive(mutator: (trip: TripRecord) => TripRecord) {
    if (!active) return
    const next = mutator(active)
    await persist(next)
  }

  async function importWorkbookBuffer(
    buf: ArrayBuffer,
    opts?: {
      sourceLabel?: string
      /** When set, overwrite this trip instead of creating a new one */
      replaceTrip?: TripRecord
    },
  ) {
    const sourceLabel = opts?.sourceLabel ?? 'Imported'
    if (buf.byteLength > MAX_IMPORT_BYTES) {
      setStatus('Import failed — file is too large (max 5 MB)')
      return null
    }
    const { meta, items } = parseTripWorkbook(buf)
    const dates = sanitizeMetaDates(meta.startDate, meta.endDate)
    const safeMeta = {
      ...meta,
      name: meta.name.trim() || `${sourceLabel} trip`,
      ...dates,
    }
    const withBases = ensureDayStartBases(safeMeta, items)
    setStatus(
      opts?.replaceTrip
        ? `Updating “${safeMeta.name}” from Drive…`
        : `Imported “${safeMeta.name}” · looking up places on the map…`,
    )
    const pinned = await pinTripItemsOnMap(
      withBases,
      (done, total) => {
        setStatus(`Pinning places ${done}/${total}…`)
      },
      {
        useGooglePlaces: placesEnabled,
        googleApiKey: effectiveGoogleKey || undefined,
        hotels: withBases.filter((i) => i.type === 'hotel'),
      },
    )
    const pinnedCount = pinned.filter(
      (item, i) =>
        (isValidCoord(item.lat, item.lon) && !isValidCoord(withBases[i]?.lat, withBases[i]?.lon)) ||
        (isValidCoord(item.latTo, item.lonTo) &&
          !isValidCoord(withBases[i]?.latTo, withBases[i]?.lonTo)),
    ).length
    const existing = opts?.replaceTrip
    const trip = sanitizeTripRecord({
      id: existing?.id ?? createId('TRIP'),
      meta: safeMeta,
      items: pinned,
      isExample: existing?.isExample ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await saveTrip(trip)
    if (!existing) await retireExampleTrip()
    await refresh()
    setActiveId(trip.id)
    setStatus(
      pinnedCount > 0
        ? `${existing ? 'Updated' : 'Imported'} “${safeMeta.name}” · ${pinnedCount} place${pinnedCount === 1 ? '' : 's'} pinned on the map`
        : `${existing ? 'Updated' : 'Imported'} “${safeMeta.name}”`,
    )
    return trip
  }

  /** True when imported workbook name/slug matches the active trip. */
  function importedFitsActiveTrip(tripName: string, fileName?: string): boolean {
    if (!active) return false
    const nameNorm = tripName.trim().toLowerCase()
    const activeNorm = active.meta.name.trim().toLowerCase()
    if (nameNorm && activeNorm && nameNorm === activeNorm) return true

    const activeSlug = slugTripFileBase(active.meta.name)
    if (!activeSlug) return false
    const nameSlug = slugTripFileBase(tripName)
    if (nameSlug && nameSlug === activeSlug) return true
    if (fileName) {
      const fileSlug = tripNameSlugFromDriveFileName(fileName)
      if (fileSlug && fileSlug === activeSlug) return true
    }
    return false
  }

  async function onImportFile(file: File) {
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setStatus('Import failed — file is too large (max 5 MB)')
        return
      }
      const buf = await file.arrayBuffer()
      const { meta } = parseTripWorkbook(buf)
      const tripName = meta.name.trim() || file.name.replace(/\.xlsx?$/i, '')
      if (active && importedFitsActiveTrip(tripName, file.name)) {
        await importWorkbookBuffer(buf, {
          sourceLabel: 'Imported',
          replaceTrip: active,
        })
        return
      }
      await importWorkbookBuffer(buf, { sourceLabel: 'Imported' })
    } catch (err) {
      logClientError('import', err)
      setStatus(
        publicErrorMessage(
          err,
          'Import failed — use a Trip Tracker Excel with Steps/Hotels (or legacy Schedule)',
        ),
      )
    }
  }

  async function onExportToDrive() {
    if (!active) return
    try {
      setStatus('Signing in to Google Drive…')
      const bytes = await workbookToArrayBuffer(buildTripWorkbook(active))
      const { fileName } = await uploadTripWorkbookToDrive(
        active.meta.name,
        bytes,
        active.id,
      )
      setStatus(`Saved to Drive · ${DRIVE_FOLDER_NAME}/${fileName}`)
    } catch (err) {
      logClientError('drive-export', err)
      setStatus(publicErrorMessage(err, 'Could not save to Google Drive'))
    }
  }

  async function onImportFromDrive(file: DriveFileInfo) {
    try {
      setStatus(`Downloading ${file.name} from Drive…`)
      const buf = await downloadDriveFile(file.id)
      const { meta } = parseTripWorkbook(buf)
      const tripName = meta.name.trim() || file.name.replace(/\.xlsx?$/i, '')

      if (active && importedFitsActiveTrip(tripName, file.name)) {
        rememberDriveFileForTrip(active.id, file.id, file.name)
        await importWorkbookBuffer(buf, {
          sourceLabel: 'Drive',
          replaceTrip: active,
        })
        rememberDriveFileForTrip(active.id, file.id, file.name)
        return
      }

      const created = await importWorkbookBuffer(buf, { sourceLabel: 'Drive' })
      if (created) rememberDriveFileForTrip(created.id, file.id, file.name)
    } catch (err) {
      logClientError('drive-import', err)
      setStatus(publicErrorMessage(err, 'Could not load trip from Google Drive'))
    }
  }

  async function onExport() {
    if (!active) return
    await downloadWorkbook(buildTripWorkbook(active), `${slug(active.meta.name)}.xlsx`)
    setStatus('Excel downloaded')
  }

  async function onExportExampleExcel() {
    const example =
      (await getTrip(EXAMPLE_TRIP_ID)) ??
      ({
        id: EXAMPLE_TRIP_ID,
        meta: exampleMeta,
        items: exampleItems,
        planSections: [],
        planPlaces: [],
        isExample: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } satisfies TripRecord)
    await downloadWorkbook(buildTripWorkbook(example), 'france-south-loop.xlsx')
  }

  async function onOpenExample() {
    keepExampleRef.current = true
    const example = await ensureExampleTrip()
    await refresh()
    setActiveId(example.id)
    setOverviewToken((n) => n + 1)
    setNavTab('timeline')
    setPanelOpen(true)
    setLowerMode('none')
    setRouteWalk(null)
    setStatus('Opened example')
  }

  async function onBlank() {
    setTripDialog({ mode: 'create', draft: defaultCreateDraft() })
  }

  async function onDeleteTrip(id: string) {
    const doomed = trips.find((t) => t.id === id)
    const wasActive = activeId === id
    await deleteTrip(id)
    forgetDriveFileForTrip(id)
    if (id === EXAMPLE_TRIP_ID) keepExampleRef.current = false

    await refresh()
    if (wasActive) {
      const nextList = await listTrips()
      const next =
        nextList.find((t) => !t.isExample && t.id !== EXAMPLE_TRIP_ID) ??
        nextList[0] ??
        null
      setActiveId(next?.id ?? null)
    }
    setStatus(
      doomed ? `Deleted “${doomed.meta.name}” from this device` : 'Trip deleted',
    )
  }

  function openTripEdit() {
    if (!active) return
    setTripDialog({ mode: 'edit', draft: draftFromMeta(active.meta) })
  }

  async function onTripDialogSubmit(draft: TripMetaDraft, rangeMode: RangeReconcileMode) {
    if (tripDialog?.mode === 'create') {
      const trip = await createBlankTrip({
        name: draft.name,
        startDate: draft.startDate,
        endDate: draft.endDate,
      })
      const withBases = applyTripMetaRange(
        trip.meta,
        trip.items,
        draft,
        'keep-outside',
      )
      await saveTrip({ ...trip, meta: withBases.meta, items: withBases.items })
      await retireExampleTrip()
      await refresh()
      setActiveId(trip.id)
      setOverviewToken((n) => n + 1)
      setStatus(`Created “${withBases.meta.name}” · ${countDaysLabel(draft)}`)
      setTripDialog(null)
      setNavTab('timeline')
      setPanelOpen(true)
      setLowerMode('none')
      setStartCoachOpen(true)
      return
    }

    if (!active) {
      setTripDialog(null)
      return
    }

    const result = applyTripMetaRange(active.meta, active.items, draft, rangeMode)
    await persist({ ...active, meta: result.meta, items: result.items })
    setTripDialog(null)

    let msg = `Updated “${result.meta.name}”`
    if (result.removedCount > 0) {
      msg += ` · removed ${result.removedCount} step${result.removedCount === 1 ? '' : 's'} outside the dates`
    } else if (result.widened) {
      msg += ' · dates widened to keep your existing steps'
    }
    setStatus(msg)
  }

  function countDaysLabel(draft: TripMetaDraft): string {
    const { startDate, endDate } = sanitizeMetaDates(draft.startDate, draft.endDate)
    const n = countTripDays(startDate, endDate)
    return `${n} day${n === 1 ? '' : 's'} ready`
  }

  function routesFingerprint(trip: TripRecord): string {
    return trip.items
      .map(
        (i) =>
          `${i.id}|${i.date}|${i.type}|${i.lat ?? ''}|${i.lon ?? ''}|${i.latTo ?? ''}|${i.lonTo ?? ''}`,
      )
      .join(';')
  }

  async function buildRoutes(trip: TripRecord) {
    const fp = routesFingerprint(trip)
    if (routesBuildingRef.current) return
    if (routesForTripRef.current === fp) return
    routesBuildingRef.current = true
    setRoutesStatus('Drawing drive paths…')
    try {
      const withDrives = await hydrateDriveRoutes(trip.items, (done, total) => {
        setRoutesStatus(`Drive paths ${done}/${total}`)
      })
      setRoutesStatus('Linking same-day walks & returns to hotel…')
      const walks = await buildWalkingConnectors(withDrives, (done, total) => {
        setRoutesStatus(`Walk paths ${done}/${total}`)
      })
      setConnectors(walks)
      const driveChanged = withDrives.some((item) => {
        const prev = trip.items.find((p) => p.id === item.id)
        return (item.routeCoords?.length ?? 0) !== (prev?.routeCoords?.length ?? 0)
      })
      // Always write hydrated geometry back into trip state when it changed so
      // the globe’s item.routeCoords stay in sync with “Routes ready”.
      if (driveChanged) {
        await persist({ ...trip, items: withDrives })
      }
      routesForTripRef.current = routesFingerprint({
        ...trip,
        items: driveChanged ? withDrives : trip.items,
      })
      setStatus(`Routes ready · ${walks.length} walk links`)
    } finally {
      routesBuildingRef.current = false
      setRoutesStatus(null)
    }
  }

  useEffect(() => {
    if (!active) return
    const items = ensureDayStartBases(active.meta, active.items)
    if (items.length !== active.items.length) {
      void persist({ ...active, items })
      return
    }
    void buildRoutes(active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active?.id,
    active
      ? routesFingerprint(active)
      : '',
  ])

  useEffect(() => {
    if (!active || enrichBusyRef.current) return
    const needy = active.items.filter(itemNeedsEnrich)
    if (!needy.length) return
    const keys = needy.map(
      (i) => `${i.id}|${i.place}|${i.from}|${i.to}|${i.title}`,
    )
    if (keys.every((k) => enrichAttemptedRef.current.has(k))) return
    enrichBusyRef.current = true
    for (const k of keys) enrichAttemptedRef.current.add(k)
    void (async () => {
      try {
        setEnrichProgress('0%')
        const items = await enrichNeedyTripItems(active.items, (done, total) => {
          setEnrichProgress(`${Math.round((done / total) * 100)}%`)
        })
        const next = { ...active, items }
        await persist(next)
        setStatus('Map pins updated — building routes…')
        routesForTripRef.current = null
        await buildRoutes(next)
      } finally {
        enrichBusyRef.current = false
        setEnrichProgress(null)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active?.id,
    active?.items
      .map(
        (i) =>
          `${i.id}:${i.place}:${i.from}:${i.to}:${i.lat ?? ''}:${i.lon ?? ''}:${i.latTo ?? ''}:${i.lonTo ?? ''}`,
      )
      .join('|') ?? '',
  ])

  function openInsert(afterId: string | null = null, beforeId: string | null = null) {
    const after = afterId ? active?.items.find((i) => i.id === afterId) : null
    const before = beforeId ? active?.items.find((i) => i.id === beforeId) : null
    setAddContext({
      afterId,
      beforeId,
      hint:
        after || before
          ? `Inserting between “${after?.title ?? 'start'}” and “${before?.title ?? 'end'}”.`
          : undefined,
    })
    setNavTab('timeline')
    setLowerMode('insert')
    setPanelOpen(true)
  }

  /** Auto day-base placeholders open the create sheet instead of a fake hotel Detail. */
  function openFillDayBase(item: TripItem) {
    setSelectedId(item.id)
    setAddContext({
      replaceId: item.id,
      date: item.date,
      defaultType: 'hotel',
      hint: `Day ${item.date.slice(5)} start — pick hotel, flight/train arrival, or station.`,
    })
    setNavTab('timeline')
    setLowerMode('insert')
    setDetailExpanded(false)
    setPanelOpen(true)
  }

  function stepById(id: string) {
    return active?.items.find((i) => i.id === id) ?? null
  }

  /** Highlight a step without opening Detail (list first-tap / phone map tap). */
  function highlightStep(id: string | null) {
    if (!id) {
      setSelectedId(null)
      setMapFocusEndpoint(null)
      setRouteWalk(null)
      setStepDraft(null)
      setLowerMode((m) => (m === 'detail' ? 'none' : m))
      setDetailExpanded(false)
      return
    }
    clearTempPin()
    setRouteWalk(null)
    setMapFocusEndpoint(null)
    const item = stepById(id)
    if (item && isPlaceholderBase(item)) {
      openFillDayBase(item)
      return
    }
    setSelectedId(id)
    setStepDraft(null)
    setNavTab('timeline')
    setPanelOpen(true)
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
  }

  function clearTempPin() {
    tempPinGenRef.current += 1
    setTempPin(null)
    setNearbyLinks([])
  }

  function applyPlaceToTemp(
    base: { lat: number; lon: number },
    place: PlaceLookup | null,
    query?: string,
  ) {
    setTempPin({
      lat: base.lat,
      lon: base.lon,
      label: place?.name || place?.address?.split(',')[0] || 'New pin',
      place: place?.name || '',
      address: place?.address || '',
      city: place?.city || '',
      osmId: place?.osmId || '',
      query: query || place?.query || '',
      loading: false,
    })
  }

  async function dropTempPinAt(
    pos: { lat: number; lon: number },
    opts?: { query?: string; place?: PlaceLookup | null; fly?: boolean },
  ) {
    if (!isValidCoord(pos.lat, pos.lon)) return
    if (exploreOpen) closeExplore()
    const gen = ++tempPinGenRef.current
    setRouteWalk(null)
    setSelectedId(null)
    setMapFocusEndpoint(null)
    setLowerMode((m) => (m === 'detail' ? 'none' : m))
    setDetailExpanded(false)
    setTempPin({
      lat: pos.lat,
      lon: pos.lon,
      label: opts?.place?.name || 'New pin',
      place: opts?.place?.name || '',
      address: opts?.place?.address || '',
      city: opts?.place?.city || '',
      osmId: opts?.place?.osmId || '',
      query: opts?.query || opts?.place?.query || '',
      loading: !opts?.place,
    })
    setNearbyLinks([])
    if (opts?.fly !== false) setTempFlyToken((n) => n + 1)
    setStatus('Pin dropped — hold + to save as a step')

    const items = active?.items ?? []
    void (async () => {
      let place = opts?.place ?? null
      if (!place) {
        place = await reverseGeocode(pos.lat, pos.lon)
        if (gen !== tempPinGenRef.current) return
        applyPlaceToTemp(pos, place, opts?.query)
      } else {
        applyPlaceToTemp(pos, place, opts?.query)
      }
      const links = await nearbyWalkLinks(pos, items, { maxKm: 3, limit: 4 })
      if (gen !== tempPinGenRef.current) return
      setNearbyLinks(links)
      const n = links.length
      setStatus(
        n
          ? `Pin ready · ${n} nearby within 3 km — press + to add`
          : 'Pin ready · no steps within 3 km — press + to add',
      )
    })()
  }

  async function searchForPlace(raw: string) {
    const q = raw.trim()
    if (!q) return
    setSearchBusy(true)
    setStatus('Searching…')
    try {
      const pasted = extractCoordsFromText(q)
      if (pasted) {
        await dropTempPinAt(pasted, { query: q })
        return
      }
      const query =
        locationQueryFromInput(q) || (/^https?:\/\//i.test(q) ? '' : q)
      if (!query) {
        setStatus('Couldn’t read that link — paste an address or Maps place URL')
        return
      }
      const bias =
        tempPin && isValidCoord(tempPin.lat, tempPin.lon)
          ? { lat: tempPin.lat, lon: tempPin.lon, radiusM: 80_000 }
          : selected && isValidCoord(selected.lat, selected.lon)
            ? { lat: selected.lat!, lon: selected.lon!, radiusM: 80_000 }
            : undefined
      const place = await lookupPlace(query, {
        useGooglePlaces: placesEnabled,
        googleApiKey: effectiveGoogleKey || undefined,
        bias,
      })
      if (!place) {
        setStatus('No place found for that search')
        return
      }
      await dropTempPinAt(
        { lat: place.lat, lon: place.lon },
        { query, place },
      )
    } catch (err) {
      logClientError('map-search', err)
      setStatus(publicErrorMessage(err, 'Search failed — try again'))
    } finally {
      setSearchBusy(false)
    }
  }

  function selectFromMap(payload: MapSelectPayload) {
    // Trip pin / path — leave Explore; empty map taps do not close Explore
    if (exploreOpen) closeExplore()

    if (payload.kind === 'flight' || payload.kind === 'route') {
      // Keep Steps open during AI review so Save/Discard stay usable with the list
      if (!aiReview) {
        setPanelOpen(false)
      } else {
        setPanelOpen(true)
      }
      setNavTab('timeline')
      clearTempPin()
      if (payload.kind === 'flight') {
        setRouteWalk({
          kind: 'flights',
          from: payload.from,
          to: payload.to,
          date: payload.date,
          origin: payload.origin,
          destination: payload.destination,
          coords: payload.coords,
        })
      } else {
        setRouteWalk({
          kind: 'route',
          origin: payload.origin,
          destination: payload.destination,
          travelMode: payload.travelMode,
          coords: payload.coords,
        })
      }
      setMapFocusEndpoint(null)
      const item = stepById(payload.itemId)
      if (item && isPlaceholderBase(item)) {
        if (!aiReview) openFillDayBase(item)
        return
      }
      setSelectedId(payload.itemId)
      setAddContext(null)
      setLowerMode('none')
      setDetailExpanded(false)
      return
    }

    // Selecting a step pin should show it in the Steps sheet (esp. on phone)
    setNavTab('timeline')
    setPanelOpen(true)
    setRouteWalk(null)
    setMapFocusEndpoint(payload.endpoint)
    const item = stepById(payload.itemId)
    if (item && isPlaceholderBase(item)) {
      if (!aiReview) openFillDayBase(item)
      return
    }
    clearTempPin()
    setSelectedId(payload.itemId)
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
  }

  /** Second tap on an already-highlighted step — opens Detail (or fill form for placeholders). */
  function selectFromList(id: string) {
    clearTempPin()
    setRouteWalk(null)
    setMapFocusEndpoint(null)
    const item = stepById(id)
    if (item && isPlaceholderBase(item)) {
      openFillDayBase(item)
      return
    }
    if (id === selectedId && lowerMode === 'detail' && detailExpanded) {
      discardStepDetail()
      return
    }
    setSelectedId(id)
    setStepDraft(item ? cloneTripItem(item) : null)
    setNavTab('timeline')
    setLowerMode('detail')
    setDetailExpanded(true)
    setPanelOpen(true)
    setAddContext(null)
  }

  /** Close detail without writing draft (Close button / discard). */
  function discardStepDetail() {
    if (stepDraft) clearTypeSwitchMemory(stepDraft.id)
    setStepDraft(null)
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
    if (!isPhone) setSelectedId(null)
    setStatus('Changes discarded')
  }

  /** Commit draft + widen trip dates, then close (top handle). */
  function saveStepDetail() {
    if (!active || !stepDraft) {
      setStepDraft(null)
      setAddContext(null)
      setLowerMode('none')
      setDetailExpanded(false)
      if (!isPhone) setSelectedId(null)
      return
    }
    const draft = cloneTripItem(stepDraft)
    const prevEnd = active.meta.endDate
    const prevStart = active.meta.startDate
    setStepDraft(null)
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
    if (!isPhone) setSelectedId(null)
    void (async () => {
      await updateActive((t) => ({
        ...t,
        items: sortItems(t.items.map((i) => (i.id === draft.id ? draft : i))),
      }))
      const trip = await getTrip(active.id)
      const meta = trip?.meta
      if (
        meta &&
        (meta.endDate !== prevEnd || meta.startDate !== prevStart)
      ) {
        const days = countTripDays(meta.startDate, meta.endDate)
        setStatus(
          `Step saved · trip ${meta.startDate} → ${meta.endDate} (${days} days)`,
        )
      } else {
        setStatus('Step saved')
      }
    })()
  }

  function closeLower() {
    if (lowerMode === 'detail') {
      discardStepDetail()
      return
    }
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
  }

  function onSheetHandle() {
    if (lowerMode === 'detail') {
      if (!detailExpanded) {
        // First press: expand to half-screen to fill in
        setDetailExpanded(true)
        return
      }
      // Second press: save & close
      saveStepDetail()
      return
    }
    closeLower()
  }

  async function addDay() {
    if (!active) return
    const base = requireIsoDate(
      active.meta.endDate || active.meta.startDate,
      todayIso(),
    )
    const d = new Date(base + 'T12:00:00')
    if (Number.isNaN(d.getTime())) {
      setStatus('Could not add day — fix the trip start/end dates in Settings')
      return
    }
    d.setDate(d.getDate() + 1)
    const nextEnd = d.toISOString().slice(0, 10)
    const dates = sanitizeMetaDates(active.meta.startDate || base, nextEnd)
    const meta = { ...active.meta, ...dates }
    const items = ensureDayStartBases(meta, active.items)
    const newBase =
      items.find((i) => i.date === nextEnd && isPlaceholderBase(i)) ??
      items.find((i) => i.date === nextEnd) ??
      null
    await persist({ ...active, meta, items })
    // Show full strip and land on the new day's base (don't leave an old selection → scroll to start)
    setTypeFilter(null)
    setDayFilter(null)
    setSelectedId(newBase?.id ?? null)
    setLowerMode('none')
    setDetailExpanded(false)
    setNavTab('timeline')
    setPanelOpen(true)
    setStatus(`Added Day · ${nextEnd}`)
  }

  async function deleteStep(id: string) {
    if (!active) return
    clearTypeSwitchMemory(id)
    const { meta, items } = deleteStepAndPrune(active.meta, active.items, id)
    const next = { ...active, meta, items }
    await persist(next)
    if (selectedId === id) {
      setSelectedId(null)
      setLowerMode('none')
      setDetailExpanded(false)
    }
    if (dayFilter && dayFilter > meta.endDate) setDayFilter(null)
    setStatus('Step deleted')
    await buildRoutes(next)
  }

  function createStep(item: TripItem) {
    void (async () => {
      if (!active) return
      const replaceId = addContext?.replaceId
      setStatus(`Pinning “${item.title}” on the map…`)
      const pinned = await pinItemOnMap(item, {
        useGooglePlaces: placesEnabled,
        googleApiKey: effectiveGoogleKey || undefined,
        hotels: active.items.filter((i) => i.type === 'hotel'),
      })
      const withoutPlaceholder = replaceId
        ? active.items.filter((i) => i.id !== replaceId)
        : active.items
      const nextItems = sortItems([...withoutPlaceholder, pinned])
      const next = { ...active, items: ensureDayStartBases(active.meta, nextItems) }
      await persist(next)
      clearTempPin()
      setRouteWalk(null)
      setSelectedId(pinned.id)
      setStepDraft(cloneTripItem(pinned))
      setAddContext(null)
      setNavTab('timeline')
      setLowerMode('detail')
      setDetailExpanded(true)
      setPanelOpen(true)

      const isLeg = ['flight', 'train', 'bus', 'ferry', 'drive'].includes(pinned.type)
      const hasFrom = isValidCoord(pinned.lat, pinned.lon)
      const hasTo = isValidCoord(pinned.latTo, pinned.lonTo)

      if (isLeg && hasFrom && hasTo) {
        // Light up the full A→B path so flights/drives aren’t mistaken for a single pin
        const coords: [number, number][] =
          pinned.routeCoords && pinned.routeCoords.length > 1
            ? pinned.routeCoords
            : [
                [pinned.lat!, pinned.lon!],
                [pinned.latTo!, pinned.lonTo!],
              ]
        if (pinned.type === 'flight') {
          setRouteWalk({
            kind: 'flights',
            from: pinned.from || pinned.title,
            to: pinned.to || '',
            date: pinned.date,
            origin: { lat: pinned.lat!, lon: pinned.lon! },
            destination: { lat: pinned.latTo!, lon: pinned.lonTo! },
            coords,
          })
        } else {
          setRouteWalk({
            kind: 'route',
            origin: { lat: pinned.lat!, lon: pinned.lon! },
            destination: { lat: pinned.latTo!, lon: pinned.lonTo! },
            travelMode: travelModeForLeg(pinned.type),
            coords,
          })
        }
        setMapFocusEndpoint(null)
        setStatus(`Added “${pinned.title}” · path on the map`)
      } else if (isLeg && hasFrom && !hasTo) {
        setStatus(
          `Added “${pinned.title}” · departure pinned — add a destination (To) for the path`,
        )
      } else if (isLeg && !hasFrom && hasTo) {
        setStatus(
          `Added “${pinned.title}” · arrival pinned — add an origin (From) for the path`,
        )
      } else {
        const onMap = hasFrom
          ? ' · on the map'
          : ' · no pin yet (check the address)'
        setStatus(`Added “${pinned.title}”${onMap}`)
      }
      await buildRoutes(next)
    })()
  }

  /** Promote the temp map pin into a real step and open its Detail sheet. */
  function createStepFromTempPin() {
    if (!active || !tempPin || !isValidCoord(tempPin.lat, tempPin.lon)) {
      openInsert(null, null)
      return
    }
    const title =
      tempPin.place?.trim() ||
      tempPin.label?.trim() ||
      tempPin.address?.split(',')[0]?.trim() ||
      'Map pin'
    const date = requireIsoDate(
      suggestDateFromNearby(
        dayFilter,
        nearbyLinks,
        active.meta.startDate || todayIso(),
      ),
      todayIso(),
    )
    const item: TripItem = {
      id: createId('S'),
      type: 'sight',
      title,
      place: tempPin.address?.trim() || tempPin.place?.trim() || title,
      city: tempPin.city?.trim() || '',
      date,
      endDate: '',
      start: '',
      end: '',
      from: '',
      to: '',
      confirm: '',
      cost: null,
      currency: normalizeCurrency(active.meta.homeCurrency || 'EUR'),
      status: 'planned',
      notes: '',
      url: '',
      tags: [],
      lat: tempPin.lat,
      lon: tempPin.lon,
      latTo: null,
      lonTo: null,
      wikidata: '',
      osmId: tempPin.osmId || '',
      rating: null,
      googleMapsUri: '',
      geocodeQuery: tempPin.query || tempPin.address || title,
      updatedAt: nowIso(),
      enrichmentSummary: tempPin.address || '',
      enrichmentImage: '',
      enrichmentSource: tempPin.address ? 'nominatim' : '',
      routeCoords: [],
      source: 'app',
    }
    void (async () => {
      const nextItems = sortItems([...active.items, item])
      const next = { ...active, items: ensureDayStartBases(active.meta, nextItems) }
      await persist(next)
      clearTempPin()
      setRouteWalk(null)
      setMapFocusEndpoint(null)
      setSelectedId(item.id)
      setStepDraft(cloneTripItem(item))
      setAddContext(null)
      setNavTab('timeline')
      setLowerMode('detail')
      setDetailExpanded(true)
      setPanelOpen(true)
      setStatus(`Added “${item.title}” · ${date} · rebuilding paths…`)
      await buildRoutes(next)
      setStatus(`Added “${item.title}” · on the map`)
    })()
  }

  function closeExplore() {
    exploreAbortRef.current?.abort()
    exploreAbortRef.current = null
    setExploreOpen(false)
    setExplorePlaces([])
    setExploreFocusId(null)
    setExploreDetail(null)
    setExploreError(null)
    setExploreBusy(false)
    setExploreAnchor(null)
  }

  function openExploreFromMap() {
    if (!active || aiReview) return
    if (aiOpen) {
      setAiOpen(false)
      setAiRestore(null)
    }
    let lat: number | null = null
    let lon: number | null = null
    let label = 'Here'
    let date = dayFilter || active.meta.startDate || todayIso()
    let stepId: string | undefined

    if (tempPin && isValidCoord(tempPin.lat, tempPin.lon)) {
      lat = tempPin.lat
      lon = tempPin.lon
      label =
        tempPin.place?.trim() ||
        tempPin.label?.trim() ||
        tempPin.address?.split(',')[0]?.trim() ||
        'Map pin'
      date = requireIsoDate(
        suggestDateFromNearby(dayFilter, nearbyLinks, date),
        date,
      )
    } else if (routeWalk) {
      // Paths (walk / drive / transit / flight) do not open Explore
      setStatus('Explore is for pins and steps — not paths')
      return
    } else if (
      selected &&
      mapFocusEndpoint === 'b' &&
      isValidCoord(selected.latTo, selected.lonTo)
    ) {
      lat = selected.latTo!
      lon = selected.lonTo!
      label = selected.title
      date = selected.date || date
      stepId = selected.id
    } else if (selected && isValidCoord(selected.lat, selected.lon)) {
      lat = selected.lat!
      lon = selected.lon!
      label = selected.title
      date = selected.date || date
      stepId = selected.id
    } else if (selected && isValidCoord(selected.latTo, selected.lonTo)) {
      lat = selected.latTo!
      lon = selected.lonTo!
      label = selected.title
      date = selected.date || date
      stepId = selected.id
    }

    if (!isValidCoord(lat, lon)) {
      setStatus('Select a pin or step to explore nearby')
      return
    }

    exploreAbortRef.current?.abort()
    const ac = new AbortController()
    exploreAbortRef.current = ac
    setExploreAnchor({ lat: lat!, lon: lon!, label, date, stepId })
    setExploreOpen(true)
    setExploreBusy(true)
    setExploreError(null)
    setExplorePlaces([])
    setExploreFocusId(null)
    setExploreDetail(null)
    setLowerMode('none')
    setDetailExpanded(false)
    setPanelOpen(true)
    setNavTab('timeline')

    void (async () => {
      let showedCache = false
      try {
        const places = await fetchNearbyExplore(
          { lat: lat!, lon: lon! },
          {
            signal: ac.signal,
            useGooglePlaces: placesEnabled,
            googleApiKey: effectiveGoogleKey || undefined,
            onCacheHit: (cached) => {
              if (ac.signal.aborted) return
              showedCache = true
              setExplorePlaces(cached)
              setExploreBusy(false)
              setExploreError(null)
            },
          },
        )
        if (ac.signal.aborted) return
        setExplorePlaces(places)
        if (!places.length) setExploreError('No nearby places found')
        else setExploreError(null)
      } catch (err) {
        if (ac.signal.aborted) return
        logClientError('explore', err)
        if (!showedCache) {
          setExploreError(publicErrorMessage(err, 'Could not load nearby places'))
        }
      } finally {
        if (!ac.signal.aborted) setExploreBusy(false)
      }
    })()
  }

  function selectExplorePlace(place: ExplorePlace) {
    const hydrated = place.tags.googlePhotoName
      ? hydrateGooglePlacePhoto(place, effectiveGoogleKey || undefined)
      : place
    setExploreFocusId(hydrated.id)
    setExploreDetail(hydrated)
    setExplorePlaces((prev) =>
      prev.map((p) => (p.id === hydrated.id ? { ...p, images: hydrated.images } : p)),
    )
    setExploreFlyToken((n) => n + 1)
  }

  function closeExploreDetail() {
    setExploreDetail(null)
    setExploreFocusId(null)
    setExploreReturnToken((n) => n + 1)
  }

  function addStepFromExplore(place: ExplorePlace) {
    if (!active || !exploreAnchor) return
    const date = requireIsoDate(exploreAnchor.date, todayIso())
    const gmeta = explorePlaceTripMeta(place)
    const item: TripItem = {
      id: createId('S'),
      type: explorePlaceToItemType(place),
      title: place.name,
      place: place.address || place.name,
      city: '',
      date,
      endDate: '',
      start: '',
      end: '',
      from: '',
      to: '',
      confirm: '',
      cost: null,
      currency: normalizeCurrency(active.meta.homeCurrency || 'EUR'),
      status: 'planned',
      notes: place.summary || '',
      url: place.website || '',
      tags: place.cuisine ? [place.cuisine] : [],
      lat: place.lat,
      lon: place.lon,
      latTo: null,
      lonTo: null,
      wikidata: place.wikidata || '',
      osmId: place.osmId || '',
      rating: gmeta.rating,
      googleMapsUri: gmeta.googleMapsUri,
      geocodeQuery: place.name,
      updatedAt: nowIso(),
      enrichmentSummary: place.summary || place.address || '',
      enrichmentImage: place.images[0] || '',
      enrichmentSource: gmeta.enrichmentSource,
      routeCoords: [],
      source: 'app',
    }
    void (async () => {
      const nextItems = sortItems([...active.items, item])
      const next = { ...active, items: ensureDayStartBases(active.meta, nextItems) }
      await persist(next)
      setSelectedId(item.id)
      setExploreDetail(null)
      setExploreFocusId(null)
      setStatus(`Added “${item.title}” · rebuilding paths…`)
      await buildRoutes(next)
      setStatus(`Added “${item.title}” from Explore`)
    })()
  }

  function openAiCoach() {
    if (aiReview) return
    if (exploreOpen) closeExplore()
    setStepDraft(null)
    setLowerMode('none')
    setDetailExpanded(false)
    setAddContext(null)
    setAiOpen(true)
    setPanelOpen(true)
    setNavTab('timeline')
  }

  function closeAiCoach() {
    setAiOpen(false)
    setAiRestore(null)
    setNavTab('timeline')
    setPanelOpen(true)
    // Leave Steps day filter alone — AI day picks must not reset it
  }

  function beginAiImplement(args: {
    day: string
    option: AiCoachOption
    candidates: ExplorePlace[]
    session: AiCoachSessionRestore
  }) {
    if (!active) return
    const result = applyCoachPatch({
      trip: active,
      day: args.day,
      patch: args.option.patch,
      candidates: args.candidates,
    })
    if (!result.ok) {
      setStatus(result.error)
      return
    }
    const intact = assertOtherDaysIntact(active.items, result.items, args.day)
    if (intact) {
      setStatus(intact)
      return
    }
    setAiOpen(false)
    setAiReview({
      beforeItems: active.items.map((i) => ({
        ...i,
        tags: [...(i.tags ?? [])],
        routeCoords: i.routeCoords
          ? i.routeCoords.map((c) => [...c] as [number, number])
          : [],
      })),
      draftItems: result.items,
      optionId: args.option.id,
      day: args.day,
      session: args.session,
      addedIds: result.addedIds,
      error: null,
    })
    setDayFilter(args.day)
    setTypeFilter(null)
    setNavTab('timeline')
    setPanelOpen(true)
    setLowerMode('none')
    setDetailExpanded(false)

    const removedN = result.removedIds.length
    const addedN = result.addedIds.length
    if (removedN && !addedN) {
      setStatus(
        `Removed ${removedN} stop${removedN === 1 ? '' : 's'} — review the lighter day, then Save or Discard.`,
      )
    } else if (removedN) {
      setStatus(
        `Updated day (+${addedN} / −${removedN}). Review, then Save or Discard.`,
      )
    }

    const newSpots = newSpotsForOverview(result.items, result.addedIds)
    if (newSpots.length === 0) {
      setSubsetFitItems([])
      // Pure trim: clear selection so timeline shows the day without a stuck highlight
      setSelectedId(
        result.changedIds[0] ??
          (removedN
            ? null
            : result.addedIds[0] ?? null),
      )
      if (removedN) {
        setOverviewToken((n) => n + 1)
      }
    } else if (newSpots.length <= 2) {
      const earliest = earliestNewSpot(result.items, result.addedIds)
      setSubsetFitItems([])
      setSelectedId(
        earliest?.id ?? result.addedIds[0] ?? result.changedIds[0] ?? null,
      )
    } else {
      setSelectedId(null)
      setSubsetFitItems(newSpots)
      setSubsetFitToken((n) => n + 1)
    }

    void (async () => {
      const draftTrip = { ...active, items: result.items }
      const reviewDay = args.day
      setRoutesStatus('Drawing AI day paths…')
      try {
        const withDrives = await hydrateDriveRoutes(draftTrip.items)
        // Only rebuild walks for the coached day (merge) so nearby sight walks
        // show up quickly in review without re-routing the whole trip.
        const dayWalks = await buildWalkingConnectors(withDrives, undefined, {
          onlyDates: [reviewDay],
        })
        setConnectors((prev) => [
          ...prev.filter((c) => c.date !== reviewDay),
          ...dayWalks,
        ])
        setAiReview((prev) =>
          prev
            ? {
                ...prev,
                draftItems: withDrives,
              }
            : null,
        )
        if (newSpots.length > 2) {
          const refreshed = newSpotsForOverview(withDrives, result.addedIds)
          if (refreshed.length) {
            setSubsetFitItems(refreshed)
            setSubsetFitToken((n) => n + 1)
          }
        }
      } finally {
        setRoutesStatus(null)
      }
    })()
  }

  async function saveAiReview() {
    if (!active || !aiReview) return
    setAiReviewBusy(true)
    const intact = assertOtherDaysIntact(
      aiReview.beforeItems,
      aiReview.draftItems,
      aiReview.day,
    )
    if (intact) {
      setAiReview((prev) => (prev ? { ...prev, error: intact } : null))
      setAiReviewBusy(false)
      return
    }
    const next = { ...active, items: aiReview.draftItems }
    const session: AiCoachSessionRestore = {
      ...aiReview.session,
      appliedOptionIds: [
        ...new Set([...aiReview.session.appliedOptionIds, aiReview.optionId]),
      ],
    }
    const day = aiReview.day
    await persist(next)
    setAiReview(null)
    setAiReviewBusy(false)
    setAiRestore(session)
    setAiOpen(true)
    setDayFilter(day)
    setNavTab('timeline')
    setPanelOpen(true)
    setStatus(`Saved AI changes · ${formatDayChipLabel(active.meta, day)}`)
    routesForTripRef.current = null
    await buildRoutes(next)
  }

  function discardAiReview() {
    if (!aiReview) return
    const session = aiReview.session
    const day = aiReview.day
    setAiReview(null)
    setAiRestore(session)
    setAiOpen(true)
    setDayFilter(day)
    setNavTab('timeline')
    setPanelOpen(true)
    setSelectedId(null)
    setStatus('Discarded AI draft')
    // Rebuild from the saved trip — do not blank connectors first (that made
    // paths vanish if rebuild was slow or aborted).
    routesForTripRef.current = null
    if (active) void buildRoutes(active)
  }

  /** Bottom binders: covering sheets close first; same binder again tucks the panel. */
  function onTongue(id: NavTab | 'insert' | 'ai') {
    // AI review lock: only allow reopening Steps (other tongues stay disabled)
    if (aiReview) {
      if (id === 'timeline') {
        setNavTab('timeline')
        setPanelOpen(true)
      }
      return
    }

    // Switch binders freely — close AI/explore/detail first, then open the target
    if (id === 'ai') {
      if (aiOpen) {
        closeAiCoach()
        return
      }
      if (exploreOpen) closeExplore()
      if (lowerMode !== 'none') {
        setLowerMode('none')
        setDetailExpanded(false)
        setAddContext(null)
      }
      openAiCoach()
      return
    }

    if (id === 'insert') {
      if (exploreOpen) closeExplore()
      if (aiOpen) {
        setAiOpen(false)
        setAiRestore(null)
      }
      if (lowerMode === 'insert') {
        setAddContext(null)
        setLowerMode('none')
        setDetailExpanded(false)
        setPanelOpen(true)
        return
      }
      setPanelOpen(true)
      if (tempPin && isValidCoord(tempPin.lat, tempPin.lon)) {
        createStepFromTempPin()
        return
      }
      openInsert(null, null)
      return
    }

    // Steps / Stats / Settings — always switch on binder press
    const wasCovering = aiOpen || exploreOpen || lowerMode !== 'none'
    if (aiOpen) {
      setAiOpen(false)
      setAiRestore(null)
    }
    if (exploreOpen) closeExplore()
    if (lowerMode !== 'none') {
      setLowerMode('none')
      setDetailExpanded(false)
      setAddContext(null)
    }

    // Same binder again (and nothing covering) → close
    if (panelOpen && navTab === id && !wasCovering) {
      setPanelOpen(false)
      return
    }

    // Different binder, or revealing Steps under AI → open that panel
    setNavTab(id)
    setPanelOpen(true)
  }

  /**
   * Day filter scopes both the timeline and the globe. AI review also sets a
   * day filter for the draft preview. Overview clears the filter (see header).
   */
  const mapItems = useMemo(() => {
    if (!displayTrip) return []
    if (dayFilter) {
      return displayTrip.items.filter((i) => itemTouchesDay(i, dayFilter))
    }
    return displayTrip.items
  }, [displayTrip, dayFilter])

  const visibleConnectors = useMemo(() => {
    if (dayFilter) {
      return connectors.filter((c) => c.date === dayFilter)
    }
    return connectors
  }, [connectors, dayFilter])

  const walkTarget = useMemo((): WalkLinkTarget | null => {
    if (tempPin && isValidCoord(tempPin.lat, tempPin.lon)) {
      return {
        kind: 'point',
        lat: tempPin.lat,
        lon: tempPin.lon,
        prefer: walkApp,
      }
    }
    if (routeWalk?.kind === 'flights') {
      return {
        kind: 'flights',
        from: routeWalk.from,
        to: routeWalk.to,
        date: routeWalk.date,
        origin: routeWalk.origin,
        destination: routeWalk.destination,
        coords: routeWalk.coords,
      }
    }
    if (routeWalk?.kind === 'route') {
      return {
        kind: 'directions',
        origin: routeWalk.origin,
        destination: routeWalk.destination,
        travelMode: routeWalk.travelMode,
        coords: routeWalk.coords,
      }
    }
    if (!selected) return null
    if (
      mapFocusEndpoint === 'b' &&
      isValidCoord(selected.latTo, selected.lonTo)
    ) {
      return {
        kind: 'point',
        lat: selected.latTo!,
        lon: selected.lonTo!,
        prefer: walkApp,
      }
    }
    if (isValidCoord(selected.lat, selected.lon)) {
      return {
        kind: 'point',
        lat: selected.lat!,
        lon: selected.lon!,
        prefer: walkApp,
      }
    }
    if (isValidCoord(selected.latTo, selected.lonTo)) {
      return {
        kind: 'point',
        lat: selected.latTo!,
        lon: selected.lonTo!,
        prefer: walkApp,
      }
    }
    return null
  }, [tempPin, routeWalk, selected, mapFocusEndpoint, walkApp])

  const lowerOpen = lowerMode !== 'none'
  const insertActive = lowerMode === 'insert'

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      {active ? (
        <div
          className={`absolute inset-0 ${appMode === 'plan' ? 'invisible pointer-events-none' : ''}`}
          data-coach="globe-map"
          aria-hidden={appMode === 'plan'}
        >
        <GlobeView
          items={mapItems}
          meta={displayTrip?.meta ?? active.meta}
          connectors={visibleConnectors}
          selectedId={selectedId}
          mapStack={effectiveMapStack}
          googleKey={effectiveGoogleKey || undefined}
          ionToken={ionToken || undefined}
          overviewToken={overviewToken}
          subsetFitToken={subsetFitToken}
          subsetFitItems={subsetFitItems}
          tripFocusId={activeId}
          openingOriginOnly={isPhone}
          phoneFraming={isPhone}
          tempPin={tempPin}
          nearbyLinks={nearbyLinks}
          tempFlyToken={tempFlyToken}
          walkTarget={walkTarget}
          onOpenWalk={() => {
            if (walkTarget) openWalkTarget(walkTarget)
          }}
          onOpenExplore={() => {
            if (aiReview) return
            openExploreFromMap()
          }}
          onExploreSelect={(placeId) => {
            const place = explorePlaces.find((p) => p.id === placeId)
            if (place) selectExplorePlace(place)
          }}
          explorePlaces={explorePlaces.map((p) => ({
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            name: p.name,
          }))}
          exploreFocusId={exploreFocusId}
          exploreFlyToken={exploreFlyToken}
          exploreReturnToken={exploreReturnToken}
          onSelect={selectFromMap}
          onMapPress={() => {
            if (aiReview) return
            // Tap map → tuck binders / AI / Explore
            if (exploreOpen) closeExplore()
            if (aiOpen) {
              setAiOpen(false)
              setAiRestore(null)
            }
            if (lowerMode !== 'none') {
              setLowerMode('none')
              setDetailExpanded(false)
              setAddContext(null)
            }
            setPanelOpen(false)
            setRouteWalk(null)
            highlightStep(null)
          }}
          onMapDoubleTap={() => {
            if (aiReview || exploreOpen || aiOpen) return
            if (tempPin) clearTempPin()
            setRouteWalk(null)
            highlightStep(null)
          }}
          onLongPress={(pos) => {
            if (aiReview) return
            setPanelOpen(false)
            void dropTempPinAt(pos)
          }}
        />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-[var(--ink-muted)]">Loading…</div>
      )}

      {appMode === 'plan' && active ? (
        <div className="absolute inset-0 z-[28] flex flex-col bg-[var(--bg)]">
          <PlanBoard
            trip={ensurePlanScaffold(active)}
            onChange={(next) => void persist(next)}
            onAskAi={(prompt) => {
              const { trip: next, message } = applyLocalPlanAi(
                ensurePlanScaffold(active),
                prompt,
              )
              void persist(next)
              setStatus(message)
            }}
          />
        </div>
      ) : null}

      {/* Map search — left of globe; long-press drops a pin under your finger */}
      <div
        className={`pointer-events-none absolute z-30 ${
          appMode === 'plan' ? 'hidden' : ''
        } left-3 top-[max(0.75rem,env(safe-area-inset-top))]`}
      >
        <div className="pointer-events-auto" data-coach="map-search">
          <MapSearchBar
            busy={searchBusy}
            onSearch={(q) => void searchForPlace(q)}
            onClear={() => {
              /* keep temp pin; only collapses the bar */
            }}
          />
        </div>
        {tempPin ? (
          <p className="pointer-events-none mt-1 max-w-[14rem] rounded-lg bg-black/45 px-2 py-1 text-[10px] text-orange-100 backdrop-blur">
            Temp pin · double-tap map to clear · <span className="font-bold">+</span> to save
            {nearbyLinks.length
              ? ` · ${nearbyLinks.length} nearby`
              : ''}
          </p>
        ) : (
          <p className="pointer-events-none mt-1 max-w-[12rem] text-[10px] text-white/55 drop-shadow">
            Long-press the map to drop a pin
          </p>
        )}
      </div>

      {/* Map-side header — desktop clears left panel; phone: right-only so search stays tappable */}
      <header
        className={`pointer-events-none absolute top-0 z-40 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] ${
          isPhone
            ? 'inset-x-0'
            : 'inset-x-0 pl-[min(24rem,90vw)]'
        }`}
      >
        <div className="pointer-events-auto ml-auto flex max-w-lg flex-col items-end gap-1.5">
          <SegmentedControl
            ariaLabel="App mode"
            value={appMode}
            onChange={(mode) => {
              setAppMode(mode)
              void setSetting('appMode', mode)
              if (mode === 'plan') {
                setExploreOpen(false)
                setAiOpen(false)
                setLowerMode('none')
                if (active) void persist(ensurePlanScaffold(active))
              }
            }}
            options={[
              { id: 'journey', label: 'Journey' },
              { id: 'plan', label: 'Plan' },
            ]}
          />
          {appMode === 'journey' ? (
            <>
          <div className="text-right">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-orange-300/90">
              Trip journal
            </div>
            <button
              type="button"
              className="group max-w-full text-right disabled:cursor-default"
              onClick={() => openTripEdit()}
              disabled={!active}
              title="Tap to edit trip name and start/end dates"
              aria-label={
                active
                  ? `Edit trip: ${active.meta.name}. Tap to change name and dates.`
                  : 'No active trip'
              }
            >
              <h1 className="brand-mark truncate text-xl text-white drop-shadow decoration-white/40 underline-offset-4 group-hover:underline group-disabled:no-underline">
                {active?.meta.name ?? '…'}
              </h1>
              <p className="text-xs text-white/70 drop-shadow">
                {active?.meta.startDate} → {active?.meta.endDate}
                {active?.isExample ? ' · example' : ''}
              </p>
            </button>
          </div>
          <div className="flex max-w-full flex-nowrap items-center justify-end gap-1">
            <TripSwitcher
              trips={trips}
              activeId={activeId}
              onSelect={(id) => setActiveId(id)}
              onDelete={(id) => onDeleteTrip(id)}
              onCreate={() => void onBlank()}
              onPrepareDelete={() => {
                setPanelOpen(false)
                setExploreOpen(false)
                setExploreDetail(null)
                setAiOpen(false)
                setAiRestore(null)
                setLowerMode('none')
                setDetailExpanded(false)
              }}
            />
            <button
              className="ui-icon-btn"
              onClick={() => {
                if (!aiReview) setDayFilter(null)
                setOverviewToken((n) => n + 1)
              }}
            >
              Overview
            </button>
            <button
              type="button"
              className="ui-icon-btn bg-orange-500/90 text-white border-orange-400/40"
              title="Feature tips"
              onClick={() => openFeatureGuide({ all: true })}
            >
              Tips
            </button>
          </div>
          {status ? <p className="text-right text-xs text-emerald-300">{status}</p> : null}
          {enrichProgress ? (
            <p className="text-right text-xs text-amber-200">Enriching… {enrichProgress}</p>
          ) : null}
          {routesStatus ? (
            <p className="text-right text-xs text-sky-200">{routesStatus}</p>
          ) : null}
            <div className="mt-1.5 flex justify-end">
              <MapLayersControl
                panelPlacement="below"
                mapLook={mapLook}
                mapStack={mapStack}
                googleKeyConfigured={placesEnabled}
                onLookChange={(look) => {
                  setMapLook(look)
                  void setSetting('mapLook', look)
                }}
                onStackChange={(id) => {
                  setMapStack(id)
                  void setSetting('mapStack', id)
                }}
              />
            </div>
            </>
          ) : (
            <>
              {status ? <p className="text-right text-xs text-emerald-300">{status}</p> : null}
            </>
          )}
        </div>
      </header>

      {aiReview && active ? (
        <AiReviewChrome
          dayLabel={formatDayChipLabel(active.meta, aiReview.day)}
          busy={aiReviewBusy}
          error={aiReview.error}
          onDiscard={discardAiReview}
          onSave={() => void saveAiReview()}
        />
      ) : null}

      {/* Journey book dock — divider tongues pull the sheet up from the bottom */}
      {appMode === 'journey' ? (
        <JourneyBookDock
          open={(panelOpen || exploreOpen || aiOpen || !!aiReview) && lowerMode !== 'insert'}
          wide={!isPhone}
          pagesClassName={
            aiOpen
              ? 'book-pages-ai'
              : exploreOpen
                ? exploreDetail
                  ? 'book-pages-explore-detail'
                  : 'book-pages-explore'
                : aiReview
                  ? 'book-pages-ai-review'
                  : navTab === 'timeline'
                    ? 'book-pages-steps'
                    : navTab === 'settings' || navTab === 'charts'
                      ? 'book-pages-tall'
                      : 'book-pages-steps'
          }
          tongues={JOURNEY_TONGUES}
          isTongueOn={(id) =>
            id === 'insert'
              ? insertActive
              : id === 'ai'
                ? aiOpen && !aiReview
                : navTab === id && !insertActive && (panelOpen || !!aiReview) && !aiOpen
          }
          isTongueDisabled={(id) => Boolean(aiReview) && id !== 'timeline'}
          onTongue={(id) => onTongue(id)}
          tongueTitle={(id) =>
            id === 'insert'
              ? tempPin
                ? 'Save map pin as step'
                : 'Insert step'
              : id === 'ai'
                ? AI_COACH_BETA_TIP
                : JOURNEY_TONGUES.find((t) => t.id === id)?.label
          }
          renderTongueLabel={(id, label) =>
            id === 'ai' ? <AiSparkIcon className="mx-auto h-4 w-4" /> : label
          }
          insertHighlight={Boolean(tempPin)}
        >
          {aiOpen && active && !aiReview ? (
            <div
              className="min-h-0 flex-1 overflow-hidden"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
            >
              <AiCoachSheet
                open
                phone={isPhone}
                meta={active.meta}
                trip={active}
                placesEnabled={placesEnabled}
                googleApiKey={effectiveGoogleKey || undefined}
                restore={aiRestore}
                onClose={closeAiCoach}
                onDayPicked={() => {
                  /* AI day is local to the coach — Steps filter stays put */
                }}
                onImplement={beginAiImplement}
              />
            </div>
          ) : null}

          {exploreOpen && !aiOpen ? (
            <div
              className="min-h-0 flex-1 overflow-hidden"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
            >
              <ExploreSheet
                open
                busy={exploreBusy}
                error={exploreError}
                places={explorePlaces}
                selectedId={exploreFocusId}
                detail={exploreDetail}
                anchor={exploreAnchor}
                onClose={closeExplore}
                onSelect={selectExplorePlace}
                onCloseDetail={closeExploreDetail}
                onAddStep={addStepFromExplore}
                phone={isPhone}
              />
            </div>
          ) : null}

          {navTab === 'timeline' && displayTrip ? (
            <div
              className={
                exploreOpen || aiOpen
                  ? 'pointer-events-none invisible absolute inset-0 flex min-h-0 flex-col overflow-hidden px-2 pb-2 pt-2'
                  : 'flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-2'
              }
              data-coach="trip-steps"
              aria-hidden={exploreOpen || aiOpen}
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <TimelinePanel
                  meta={displayTrip.meta}
                  items={displayTrip.items}
                  selectedId={selectedId}
                  dayFilter={dayFilter}
                  typeFilter={typeFilter}
                  onSelect={highlightStep}
                  onOpenDetail={selectFromList}
                  onDayFilter={setDayFilter}
                  onTypeFilter={setTypeFilter}
                  onInsertBetween={(after, before) => openInsert(after, before)}
                  onAddDay={() => void addDay()}
                  onDeleteStep={(id) => void deleteStep(id)}
                  layout={isPhone ? 'horizontal' : 'vertical'}
                  detailOpen={!isPhone && lowerMode === 'detail'}
                  lockMode={Boolean(aiReview)}
                />
              </div>
            </div>
          ) : null}

          {!exploreOpen && !aiOpen && navTab === 'charts' && active ? (
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-2"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
            >
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
                <ChartsPanel
                  meta={active.meta}
                  items={active.items}
                  ownScroll={false}
                  onHomeCurrencyChange={(code) =>
                    void updateActive((t) => ({
                      ...t,
                      meta: { ...t.meta, homeCurrency: normalizeCurrency(code) },
                    }))
                  }
                />
              </div>
            </div>
          ) : null}

          {!exploreOpen && !aiOpen && navTab === 'settings' ? (
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-3 pt-2 text-sm"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
            >
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
              <DataPanel
                active={active}
                colorMode={colorMode}
                googleKey={googleKey}
                serverPlacesConfigured={serverPlacesConfigured}
                ionToken={ionToken}
                walkApp={walkApp}
                onColorModeChange={(mode) => {
                  setColorMode(mode)
                  applyColorMode(mode)
                  void setSetting('colorMode', mode)
                }}
                onOpenExample={() => void onOpenExample()}
                onImportFile={(f) => void onImportFile(f)}
                onExport={() => void onExport()}
                onExportToDrive={() => void onExportToDrive()}
                onImportFromDrive={(f) => void onImportFromDrive(f)}
                onExportExampleExcel={() => void onExportExampleExcel()}
                onAddDay={() => void addDay()}
                onEditTrip={() => openTripEdit()}
                onShowTips={() => openFeatureGuide({ all: true })}
                onStatus={setStatus}
                setWalkApp={(pref) => {
                  setWalkApp(pref)
                  void setSetting('walkApp', pref)
                }}
                setGoogleKey={setGoogleKey}
                setIonToken={setIonToken}
                updateActive={updateActive}
              />
              </div>
            </div>
          ) : null}
        </JourneyBookDock>
      ) : null}

      {/* Detail / Insert bottom sheet — covers steps on phone; tongues stay reachable */}
      {lowerOpen ? (
        <section
          className={`journal-sheet absolute inset-x-0 z-40 flex flex-col rounded-t-[1.75rem] border shadow-[0_-12px_40px_rgba(15,23,42,0.35)] transition-all ${
            'bottom-[3.1rem]'
          } ${
            lowerMode === 'insert'
              ? isPhone
                ? 'h-[82%]'
                : 'h-[70%]'
              : detailExpanded
                ? isPhone
                  ? 'h-[62%]'
                  : 'h-[50%]'
                : 'h-[26%]'
          }`}
        >
          <button
            type="button"
            className="flex w-full flex-col items-center gap-0.5 pb-1 pt-1"
            onClick={onSheetHandle}
            title={
              lowerMode === 'detail'
                ? detailExpanded
                  ? 'Tap to save & close'
                  : 'Tap to expand'
                : 'Close'
            }
          >
            <div className="sheet-handle" />
            {lowerMode === 'detail' ? (
              <span className="text-[10px] font-medium text-stone-400">
                {detailExpanded ? 'Tap to save & close' : 'Tap to expand'}
              </span>
            ) : null}
          </button>
          <div
            className={`min-h-0 flex-1 overflow-hidden px-3 text-stone-800 ${
              isPhone ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'
            }`}
          >
            {lowerMode === 'detail' && detailItem ? (
              <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
                <ItemDrawer
                  item={detailItem}
                  onClose={discardStepDetail}
                  onChange={(item) => {
                    if (aiReview) {
                      if (!itemTouchesDay(item, aiReview.day)) return
                      setAiReview((prev) =>
                        prev
                          ? {
                              ...prev,
                              draftItems: sortItems(
                                prev.draftItems.map((i) =>
                                  i.id === item.id ? item : i,
                                ),
                              ),
                            }
                          : null,
                      )
                      return
                    }
                    setStepDraft(cloneTripItem(item))
                  }}
                  onDelete={(id) => {
                    if (aiReview) return
                    setStepDraft(null)
                    void deleteStep(id)
                  }}
                />
              </div>
            ) : null}

            {lowerMode === 'detail' && !detailItem ? (
              <p className="text-sm text-stone-500">Select a step on the map or timeline.</p>
            ) : null}

            {lowerMode === 'insert' && active ? (
              <div className="h-full min-h-0">
                <AddStepPanel
                  meta={active.meta}
                  items={active.items}
                  context={addContext}
                  onCancel={closeLower}
                  onCreate={(item) => createStep(item)}
                />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <FeatureGuide
        open={guideOpen}
        tips={guideTips}
        onClose={() => setGuideOpen(false)}
        onMarkSeen={(ids) => void markTipsSeen(ids)}
      />
      <TripMetaDialog
        open={!!tripDialog}
        mode={tripDialog?.mode ?? 'create'}
        initial={tripDialog?.draft ?? defaultCreateDraft()}
        trip={tripDialog?.mode === 'edit' ? active : null}
        onClose={() => setTripDialog(null)}
        onSubmit={onTripDialogSubmit}
      />
      <TripStartCoach
        open={startCoachOpen}
        tripName={active?.meta.name}
        onDismiss={() => setStartCoachOpen(false)}
      />
    </div>
  )
}

function DriveSyncPanel({
  active,
  onExportToDrive,
  onImportFromDrive,
  onStatus,
}: {
  active: TripRecord | null
  onExportToDrive: () => void
  onImportFromDrive: (file: DriveFileInfo) => void
  onStatus: (msg: string) => void
}) {
  const configured = isGoogleDriveConfigured()
  const [connected, setConnected] = useState(() => isGoogleDriveConnected())
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<DriveFileInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onConnect() {
    setBusy(true)
    setError(null)
    try {
      await connectGoogleDrive()
      setConnected(true)
      onStatus('Google Drive connected')
      try {
        const list = await listTripWorkbooksOnDrive()
        setFiles(list)
        onStatus(
          list.length
            ? `Drive ready · ${list.length} workbook${list.length === 1 ? '' : 's'} in ${DRIVE_FOLDER_NAME}/`
            : `Drive ready · ${DRIVE_FOLDER_NAME}/ (empty)`,
        )
      } catch (listErr) {
        logClientError('drive-list', listErr)
        const msg =
          listErr instanceof Error ? listErr.message : 'Could not list Drive files'
        setError(msg)
        onStatus(msg)
        setFiles([])
      }
    } catch (err) {
      logClientError('drive-connect', err)
      setConnected(false)
      const msg = err instanceof Error ? err.message : 'Google sign-in failed'
      setError(msg)
      onStatus(msg)
    } finally {
      setBusy(false)
    }
  }

  function onDisconnect() {
    disconnectGoogleDrive()
    setConnected(false)
    setFiles(null)
    setError(null)
    onStatus('Google Drive disconnected')
  }

  async function onRefreshList() {
    setBusy(true)
    setError(null)
    try {
      const list = await listTripWorkbooksOnDrive()
      setFiles(list)
      setConnected(true)
      onStatus(
        list.length
          ? `Drive · ${list.length} workbook${list.length === 1 ? '' : 's'}`
          : `Drive · ${DRIVE_FOLDER_NAME}/ is empty`,
      )
    } catch (err) {
      logClientError('drive-list', err)
      const msg = err instanceof Error ? err.message : 'Could not list Drive files'
      setError(msg)
      onStatus(msg)
    } finally {
      setBusy(false)
    }
  }

  async function onOpenFolder() {
    setBusy(true)
    setError(null)
    try {
      const url = await resolveDriveFolderOpenUrl()
      if (!url) throw new Error('Drive folder is not available yet — Connect first')
      openExternalUrl(url)
    } catch (err) {
      logClientError('drive-open-folder', err)
      const msg = err instanceof Error ? err.message : 'Could not open Drive folder'
      setError(msg)
      onStatus(msg)
    } finally {
      setBusy(false)
    }
  }

  function onOpenFile(file: DriveFileInfo) {
    openExternalUrl(file.webViewLink || driveFileWebUrl(file.id))
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
        Google Drive
      </div>
      <p className="mt-1 text-xs text-stone-600">
        Saves Excel into <code className="rounded bg-white px-1">{DRIVE_FOLDER_NAME}/</code>. Each
        trip keeps one Drive file — renaming the trip renames that file on the next save. Load
        updates the current trip when the workbook name matches; otherwise it creates a new trip
        and switches to it. Open opens the folder or file in Google Drive. Manual uploads in that
        folder show up after Connect (allow full Drive access when Google asks). If an older save
        won’t open in Sheets, delete it and Save trip to Drive again.
      </p>
      {!configured ? (
        <p className="mt-2 text-xs text-amber-800">
          Set <code className="rounded bg-white px-1">VITE_GOOGLE_OAUTH_CLIENT_ID</code> in{' '}
          <code className="rounded bg-white px-1">.env.local</code> (OAuth web client) and restart
          Vite. Add <code className="rounded bg-white px-1">{window.location.origin}</code> to
          Authorized JavaScript origins.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {!connected ? (
            <button
              type="button"
              className={btnPrimary}
              disabled={busy}
              onClick={() => void onConnect()}
            >
              {busy ? 'Connecting…' : 'Connect Google'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || !active}
                onClick={onExportToDrive}
              >
                Save trip to Drive
              </button>
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => void onOpenFolder()}
              >
                Open folder
              </button>
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => void onRefreshList()}
              >
                Refresh list
              </button>
              <button type="button" className={btn} disabled={busy} onClick={onDisconnect}>
                Disconnect
              </button>
            </>
          )}
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}
      {connected && files ? (
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-emerald-100 bg-white/80 p-2">
          {!files.length ? (
            <p className="text-xs text-stone-400">No workbooks in {DRIVE_FOLDER_NAME}/ yet.</p>
          ) : (
            files.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-stone-700 hover:bg-emerald-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={f.name}>
                  {f.name}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 hover:bg-sky-50"
                  disabled={busy}
                  title="Open in Google Drive"
                  onClick={() => onOpenFile(f)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
                  disabled={busy}
                  title="Load into the app"
                  onClick={() => onImportFromDrive(f)}
                >
                  Load
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function DataPanel({
  active,
  colorMode,
  googleKey,
  serverPlacesConfigured,
  ionToken,
  walkApp,
  onColorModeChange,
  onOpenExample,
  onImportFile,
  onExport,
  onExportToDrive,
  onImportFromDrive,
  onExportExampleExcel,
  onAddDay,
  onEditTrip,
  onShowTips,
  onStatus,
  setWalkApp,
  setGoogleKey,
  setIonToken,
  updateActive,
}: {
  active: TripRecord | null
  colorMode: ColorMode
  googleKey: string
  serverPlacesConfigured: boolean
  ionToken: string
  walkApp: WalkAppPref
  onColorModeChange: (mode: ColorMode) => void
  onOpenExample: () => void
  onImportFile: (f: File) => void
  onExport: () => void
  onExportToDrive: () => void
  onImportFromDrive: (file: DriveFileInfo) => void
  onExportExampleExcel: () => void
  onAddDay: () => void
  onEditTrip: () => void
  onShowTips: () => void
  onStatus: (msg: string) => void
  setWalkApp: (pref: WalkAppPref) => void
  setGoogleKey: (v: string) => void
  setIonToken: (v: string) => void
  updateActive: (mutator: (trip: TripRecord) => TripRecord) => Promise<void>
}) {
  return (
    <>
      <div className="settings-card">
        <div className="settings-card-title">Appearance</div>
        <SegmentedControl
          ariaLabel="Color mode"
          value={colorMode}
          onChange={onColorModeChange}
          options={[
            { id: 'light', label: 'Cream' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
        <p className="mt-2 text-[11px] leading-snug text-[var(--ink-muted)]">
          Cream is the warm paper look; Dark is the glass night shell.
        </p>
      </div>

      {active ? (
        <div className="settings-card">
          <div className="settings-card-title">This trip</div>
          <button
            type="button"
            className={`${btn} mb-2 w-full justify-between`}
            onClick={onEditTrip}
          >
            <span className="truncate font-medium">{active.meta.name}</span>
            <span className="shrink-0 text-[var(--ink-muted)]">
              {active.meta.startDate} → {active.meta.endDate}
            </span>
          </button>
          <button type="button" className={`${btn} mb-2 w-full`} onClick={onAddDay}>
            + Add a day
          </button>
          <label className="mb-2 block text-xs text-[var(--ink-muted)]">
            Home currency
            <select
              className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
              value={active.meta.homeCurrency || 'EUR'}
              onChange={(e) =>
                void updateActive((t) => ({
                  ...t,
                  meta: {
                    ...t.meta,
                    homeCurrency: normalizeCurrency(e.target.value),
                  },
                }))
              }
            >
              {['ILS', 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'].map((c) => (
                <option key={c} value={c}>
                  {c === 'ILS' ? 'ILS (NIS)' : c}
                </option>
              ))}
            </select>
          </label>
          <textarea
            className="w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-[var(--ink)]"
            rows={3}
            value={active.meta.notes}
            onChange={(e) =>
              void updateActive((t) => ({
                ...t,
                meta: { ...t.meta, notes: e.target.value },
              }))
            }
            placeholder="Notes…"
          />
        </div>
      ) : null}

      <div className="settings-card">
        <div className="settings-card-title">Import & export</div>
        <ActionRow>
          <label className={btn}>
            Import Excel
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImportFile(f)
                e.target.value = ''
              }}
            />
          </label>
          <button type="button" className={btn} onClick={onExport} disabled={!active}>
            Export Excel
          </button>
          <button type="button" className={btn} onClick={onExportExampleExcel}>
            Example .xlsx
          </button>
        </ActionRow>
        <div className="mt-2">
          <DriveSyncPanel
            active={active}
            onExportToDrive={onExportToDrive}
            onImportFromDrive={onImportFromDrive}
            onStatus={onStatus}
          />
        </div>
        <p className="mt-2 text-[11px] text-[var(--ink-muted)]">
          Excel uses Trip + Steps + Hotels + Cash. Types: {ITEM_TYPES.join(', ')}.
        </p>
      </div>

      <div className="settings-card">
        <div className="settings-card-title">Map & links</div>
        <div className="text-xs text-[var(--ink-muted)]">Walk figure opens</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {(
            [
              ['maps', 'Street View'],
              ['earth', 'Google Earth'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rounded-full px-3 py-1 text-xs ${
                walkApp === id
                  ? 'bg-[var(--sky)] text-white'
                  : 'border border-[var(--glass-border)] bg-[var(--paper)] text-[var(--ink)]'
              }`}
              onClick={() => setWalkApp(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-[var(--ink-muted)]">
          Basemap look is on the map layers button. Pins → Street View / Earth. Paths →
          directions or Flights.
        </p>
        <label className="mt-3 block text-xs text-[var(--ink-muted)]">
          Google Maps / Places key
          <input
            className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={googleKey}
            onChange={(e) => setGoogleKey(sanitizeSecretInput(e.target.value))}
            onBlur={() => void setSetting('googleMapsKey', googleKey)}
            placeholder={serverPlacesConfigured ? 'Override server key…' : 'Paste key…'}
          />
          <span className="mt-1 block text-[10px]">
            {serverPlacesConfigured
              ? 'Blank uses the server key. Photoreal 3D needs a key here.'
              : 'Optional. Prefer GOOGLE_MAPS_API_KEY on the server. 3D tiles need a key here.'}
          </span>
        </label>
        <label className="mt-3 block text-xs text-[var(--ink-muted)]">
          Cesium ion token (optional)
          <input
            className="mt-1 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] px-2 py-1.5 text-sm text-[var(--ink)]"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ionToken}
            onChange={(e) => setIonToken(sanitizeSecretInput(e.target.value))}
            onBlur={() => void setSetting('cesiumIonToken', ionToken)}
            placeholder="Paste token…"
          />
        </label>
      </div>

      <div className="settings-card">
        <div className="settings-card-title">Tools</div>
        <ActionRow>
          <button type="button" className={btnPrimary} onClick={onShowTips}>
            Feature tips
          </button>
          <button type="button" className={btn} onClick={onOpenExample}>
            Open example
          </button>
        </ActionRow>
      </div>

      <ClientLogsBlob />
    </>
  )
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

const btn =
  'cursor-pointer rounded-full border border-[var(--glass-border)] bg-[var(--paper)] px-3 py-2 text-xs font-medium leading-none text-[var(--ink)] shadow-sm inline-flex items-center'
const btnPrimary =
  'cursor-pointer rounded-full bg-[var(--coral)] px-3 py-2 text-xs font-semibold leading-none text-white disabled:opacity-50 inline-flex items-center'

function ClientLogsBlob() {
  const logs = useSyncExternalStore(
    subscribeClientLogs,
    getClientLogsSnapshot,
    () => [] as ReturnType<typeof getClientLogsSnapshot>,
  )
  const text = formatClientLogsText(logs)

  return (
    <div className="settings-card">
      <div className="flex items-center justify-between gap-2">
        <div className="settings-card-title mb-0">
          Client logs
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className={btn}
            onClick={() => void forceAppRefresh()}
          >
            Force refresh
          </button>
          <button
            type="button"
            className={btn}
            disabled={!logs.length}
            onClick={() => {
              void navigator.clipboard?.writeText(text)
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className={btn}
            disabled={!logs.length}
            onClick={() => clearClientLogs()}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-[var(--ink-muted)]">
        Explore / Places / maps-status errors land here (secrets redacted).
      </p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--glass-border)] bg-[var(--paper)] p-2 font-mono text-[10px] leading-snug text-[var(--ink)]">
        {text || 'No log lines yet.'}
      </pre>
    </div>
  )
}

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'trip'
}
