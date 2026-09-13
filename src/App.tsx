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
  enrichTripItems,
  extractCoordsFromText,
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
import { FeatureGuide } from './ui/FeatureGuide'
import {
  explorePlaceToItemType,
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
import { DEFAULT_MAP_STACK, type MapStack } from './globe/viewer'
import { firstOpenableStep } from './globe/viewer'
import { EXAMPLE_TRIP_ID, exampleItems, exampleMeta } from './data/examples/france-south-loop'
import { ensureDayStartBases, deleteStepAndPrune, isPlaceholderBase, itemTouchesDay, applyTripMetaRange, countTripDays } from './data/dayBases'
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
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [mapStack, setMapStack] = useState<MapStack>(DEFAULT_MAP_STACK)
  const [googleKey, setGoogleKey] = useState('')
  const [ionToken, setIonToken] = useState('')
  /** Data-panel override only — deploy key stays on the server. */
  const effectiveGoogleKey = resolveGoogleMapsApiKey(googleKey)
  const [serverPlacesConfigured, setServerPlacesConfigured] = useState(false)
  const placesEnabled = Boolean(effectiveGoogleKey) || serverPlacesConfigured
  const [walkApp, setWalkApp] = useState<WalkAppPref>('maps')
  const [status, setStatus] = useState('')
  const [overviewToken, setOverviewToken] = useState(0)
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
  const tempPinGenRef = useRef(0)
  const exploreAbortRef = useRef<AbortController | null>(null)

  const active = useMemo(
    () => trips.find((t) => t.id === activeId) ?? null,
    [trips, activeId],
  )

  const selected = useMemo(
    () => active?.items.find((i) => i.id === selectedId) ?? null,
    [active, selectedId],
  )

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
            : 'No server GOOGLE_MAPS_API_KEY — Explore uses OSM unless you paste a key in Data',
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
    const items = ensureDayStartBases(next.meta, next.items)
    await saveTrip({ ...next, items })
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
    const pinned = await pinTripItemsOnMap(withBases, (done, total) => {
      setStatus(`Pinning places ${done}/${total}…`)
    })
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

  function findTripForDriveWorkbook(
    tripName: string,
    fileName: string,
  ): TripRecord | undefined {
    const nameNorm = tripName.trim().toLowerCase()
    const fileSlug = tripNameSlugFromDriveFileName(fileName)
    const nameSlug = slugTripFileBase(tripName)
    const ranked = [...trips].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const exact = ranked.find((t) => t.meta.name.trim().toLowerCase() === nameNorm)
    if (exact) return exact

    return ranked.find((t) => {
      const s = slugTripFileBase(t.meta.name)
      return s === fileSlug || s === nameSlug
    })
  }

  async function onImportFile(file: File) {
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setStatus('Import failed — file is too large (max 5 MB)')
        return
      }
      await importWorkbookBuffer(await file.arrayBuffer())
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
      const match = findTripForDriveWorkbook(tripName, file.name)

      if (match) {
        // Switch to the matching trip first
        setActiveId(match.id)
        rememberDriveFileForTrip(match.id, file.id, file.name)

        const driveMs = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN
        const localMs = Date.parse(match.updatedAt)
        const driveIsNewer =
          Number.isFinite(driveMs) && (!Number.isFinite(localMs) || driveMs > localMs)

        if (!driveIsNewer) {
          setStatus(
            `Opened “${match.meta.name}” · local copy is up to date (Drive not newer) — skipped overwrite`,
          )
          return
        }

        await importWorkbookBuffer(buf, {
          sourceLabel: 'Drive',
          replaceTrip: match,
        })
        rememberDriveFileForTrip(match.id, file.id, file.name)
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

  async function buildRoutes(trip: TripRecord) {
    setRoutesStatus('Drawing drive paths…')
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
    if (driveChanged) {
      await persist({ ...trip, items: withDrives })
    }
    routesForTripRef.current = trip.id
    setRoutesStatus(null)
    setStatus(`Routes ready · ${walks.length} walk links`)
  }

  useEffect(() => {
    if (!active) return
    const items = ensureDayStartBases(active.meta, active.items)
    if (items.length !== active.items.length) {
      void persist({ ...active, items })
      return
    }
    if (routesForTripRef.current === active.id) return
    void buildRoutes(active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.items.length])

  async function onEnrich() {
    if (!active) return
    setEnrichProgress('0%')
    const items = await enrichTripItems(active.items, (done, total) => {
      setEnrichProgress(`${Math.round((done / total) * 100)}%`)
    })
    const next = { ...active, items }
    await persist(next)
    setEnrichProgress(null)
    setStatus('Enrichment complete — building routes…')
    await buildRoutes(next)
  }

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
      setLowerMode((m) => (m === 'detail' ? 'none' : m))
      setDetailExpanded(false)
      return
    }
    clearTempPin()
    const item = stepById(id)
    if (item && isPlaceholderBase(item)) {
      openFillDayBase(item)
      return
    }
    setSelectedId(id)
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
    // Selecting a step should show it in the Steps sheet (esp. on phone)
    setNavTab('timeline')
    setPanelOpen(true)

    if (payload.kind === 'flight') {
      clearTempPin()
      setRouteWalk({
        kind: 'flights',
        from: payload.from,
        to: payload.to,
        date: payload.date,
        origin: payload.origin,
        destination: payload.destination,
        coords: payload.coords,
      })
      setMapFocusEndpoint(null)
      setSelectedId(payload.itemId)
      setAddContext(null)
      setLowerMode('none')
      setDetailExpanded(false)
      return
    }

    if (payload.kind === 'route') {
      clearTempPin()
      setRouteWalk({
        kind: 'route',
        origin: payload.origin,
        destination: payload.destination,
        travelMode: payload.travelMode,
        coords: payload.coords,
      })
      setMapFocusEndpoint(null)
      const item = stepById(payload.itemId)
      if (item && isPlaceholderBase(item)) {
        openFillDayBase(item)
        return
      }
      setSelectedId(payload.itemId)
      setAddContext(null)
      setLowerMode('none')
      setDetailExpanded(false)
      return
    }
    setRouteWalk(null)
    setMapFocusEndpoint(payload.endpoint)
    const item = stepById(payload.itemId)
    if (item && isPlaceholderBase(item)) {
      openFillDayBase(item)
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
      closeLower()
      return
    }
    setSelectedId(id)
    setNavTab('timeline')
    setLowerMode('detail')
    setDetailExpanded(true)
    setPanelOpen(true)
    setAddContext(null)
  }

  function closeLower() {
    const wasDetail = lowerMode === 'detail'
    setAddContext(null)
    setLowerMode('none')
    setDetailExpanded(false)
    if (wasDetail) {
      // Phone: keep highlight on the step so the strip stays centered there
      if (!isPhone) setSelectedId(null)
      setStatus('Step saved')
    }
  }

  function onSheetHandle() {
    if (lowerMode === 'detail') {
      if (!detailExpanded) {
        // First press: expand to half-screen to fill in
        setDetailExpanded(true)
        return
      }
      // Second press: save & close
      closeLower()
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
      setStatus('Could not add day — fix the trip start/end dates in Data')
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
      const pinned = await pinItemOnMap(item)
      const withoutPlaceholder = replaceId
        ? active.items.filter((i) => i.id !== replaceId)
        : active.items
      const nextItems = sortItems([...withoutPlaceholder, pinned])
      const next = { ...active, items: ensureDayStartBases(active.meta, nextItems) }
      await persist(next)
      clearTempPin()
      setRouteWalk(null)
      setSelectedId(pinned.id)
      setAddContext(null)
      setNavTab('timeline')
      setLowerMode('detail')
      setDetailExpanded(true)
      setPanelOpen(true)
      const onMap = isValidCoord(pinned.lat, pinned.lon)
        ? ' · on the map'
        : ' · no pin yet (check the address)'
      setStatus(`Added “${pinned.title}”${onMap}`)
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
    if (!active) return
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
      geocodeQuery: place.name,
      updatedAt: nowIso(),
      enrichmentSummary: place.summary || place.address || '',
      enrichmentImage: place.images[0] || '',
      enrichmentSource: place.wikidata ? 'Wikidata' : 'OpenStreetMap',
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

  function onTongue(id: NavTab | 'insert') {
    setPanelOpen(true)
    if (id === 'insert') {
      if (tempPin && isValidCoord(tempPin.lat, tempPin.lon)) {
        createStepFromTempPin()
        return
      }
      openInsert(null, null)
      return
    }
    if (exploreOpen) closeExplore()
    setNavTab(id)
    if (id !== 'timeline') {
      setLowerMode('none')
      setAddContext(null)
    }
  }

  const filteredItems = useMemo(() => {
    if (!active) return []
    return active.items.filter((i) => {
      if (dayFilter && !itemTouchesDay(i, dayFilter)) return false
      if (typeFilter && i.type !== typeFilter) return false
      return true
    })
  }, [active, dayFilter, typeFilter])

  const visibleConnectors = useMemo(() => {
    if (!dayFilter) return connectors
    return connectors.filter((c) => c.date === dayFilter)
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
    <div className="relative h-full w-full overflow-hidden bg-[#0c1520] text-slate-100">
      {active ? (
        <div className="absolute inset-0" data-coach="globe-map">
        <GlobeView
          items={filteredItems.length ? filteredItems : active.items}
          meta={active.meta}
          connectors={visibleConnectors}
          selectedId={selectedId}
          mapStack={mapStack}
          googleKey={effectiveGoogleKey || undefined}
          ionToken={ionToken || undefined}
          overviewToken={overviewToken}
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
          onOpenExplore={() => openExploreFromMap()}
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
            // Keep Explore open on empty-map short press; close via tongues, step pin, X, or search
            if (exploreOpen) return
            setPanelOpen(false)
            setRouteWalk(null)
          }}
          onMapDoubleTap={() => {
            if (exploreOpen) return
            if (tempPin) clearTempPin()
            setRouteWalk(null)
          }}
          onLongPress={(pos) => {
            setPanelOpen(false)
            void dropTempPinAt(pos)
          }}
        />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-slate-400">Loading…</div>
      )}

      {/* Map search — left of globe; long-press drops a pin under your finger */}
      <div
        className={`pointer-events-none absolute z-30 ${
          isPhone
            ? 'left-3 top-[max(0.75rem,env(safe-area-inset-top))]'
            : panelOpen
              ? 'left-[min(23.5rem,90vw)] top-[max(0.75rem,env(safe-area-inset-top))]'
              : 'left-14 top-[max(0.75rem,env(safe-area-inset-top))]'
        }`}
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
        className={`pointer-events-none absolute top-0 z-20 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] ${
          isPhone
            ? 'right-0 max-w-[min(18rem,70vw)]'
            : 'inset-x-0 pl-[min(24rem,90vw)]'
        }`}
      >
        <div className="pointer-events-auto ml-auto flex max-w-md flex-col items-end gap-1">
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
              {active ? (
                <p className="text-[10px] text-white/45 group-hover:text-orange-200/90">
                  Tap title to edit name &amp; dates
                </p>
              ) : null}
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <TripSwitcher
              trips={trips}
              activeId={activeId}
              onSelect={(id) => setActiveId(id)}
              onDelete={(id) => onDeleteTrip(id)}
              onPrepareDelete={() => {
                setPanelOpen(false)
                setExploreOpen(false)
                setExploreDetail(null)
                setLowerMode('none')
                setDetailExpanded(false)
              }}
            />
            <button
              className="rounded-full bg-white/15 px-3 py-1 text-xs text-white backdrop-blur hover:bg-white/25"
              onClick={() => setOverviewToken((n) => n + 1)}
            >
              Overview
            </button>
            <button
              type="button"
              className="rounded-full bg-orange-500/90 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-orange-400"
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
        </div>
      </header>

      {/* Desktop: left sidebar + side book tongues */}
      {!isPhone ? (
      <aside
        className={`side-shell absolute bottom-0 left-0 top-0 z-30 flex pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] ${
          panelOpen || exploreOpen ? 'side-shell-open' : 'side-shell-collapsed'
        } ${exploreOpen ? 'side-shell-explore' : ''}`}
      >
        {panelOpen || exploreOpen ? (
          <div className="side-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {exploreOpen ? (
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
              />
            ) : (
              <>
            <div className="flex items-center justify-between gap-2 border-b border-stone-200/80 px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                {navTab === 'timeline' ? 'Steps' : navTab === 'charts' ? 'Stats' : 'Data'}
              </div>
              <button
                type="button"
                className="rounded-full px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                onClick={() => setPanelOpen(false)}
                title="Collapse panel"
              >
                ‹ Map
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {navTab === 'timeline' && active ? (
                <div className="h-full min-h-0 px-2 pb-2 pt-1" data-coach="trip-steps">
                  <TimelinePanel
                    meta={active.meta}
                    items={active.items}
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
                    layout="vertical"
                    detailOpen={lowerMode === 'detail'}
                  />
                </div>
              ) : null}

              {navTab === 'charts' && active ? (
                <div className="h-full min-h-0 px-2 pb-2 pt-1">
                  <ChartsPanel
                    meta={active.meta}
                    items={active.items}
                    onHomeCurrencyChange={(code) =>
                      void updateActive((t) => ({
                        ...t,
                        meta: { ...t.meta, homeCurrency: normalizeCurrency(code) },
                      }))
                    }
                  />
                </div>
              ) : null}

              {navTab === 'settings' ? (
                <div className="h-full min-h-0 space-y-3 overflow-y-auto overscroll-contain px-3 pb-4 pt-2 text-sm text-stone-800">
                  <DataPanel
                    active={active}
                    mapStack={mapStack}
                    googleKey={googleKey}
                    serverPlacesConfigured={serverPlacesConfigured}
                    ionToken={ionToken}
                    walkApp={walkApp}
                    enrichProgress={enrichProgress}
                    routesStatus={routesStatus}
                    onOpenExample={() => void onOpenExample()}
                    onBlank={() => void onBlank()}
                    onImportFile={(f) => void onImportFile(f)}
                    onExport={() => void onExport()}
                    onExportToDrive={() => void onExportToDrive()}
                    onImportFromDrive={(f) => void onImportFromDrive(f)}
                    onExportExampleExcel={() => void onExportExampleExcel()}
                    onEnrich={() => void onEnrich()}
                    onRebuildRoutes={() => {
                      if (!active) return
                      void buildRoutes(active)
                    }}
                    onAddDay={() => void addDay()}
                    onEditTrip={() => openTripEdit()}
                    onShowTips={() => openFeatureGuide({ all: true })}
                    onStatus={setStatus}
                    setMapStack={(id) => {
                      setMapStack(id)
                      void setSetting('mapStack', id)
                    }}
                    setWalkApp={(pref) => {
                      setWalkApp(pref)
                      void setSetting('walkApp', pref)
                    }}
                    setGoogleKey={setGoogleKey}
                    setIonToken={setIonToken}
                    updateActive={updateActive}
                  />
                </div>
              ) : null}
            </div>
              </>
            )}
          </div>
        ) : null}

        <nav className="book-tongues" aria-label="Sidebar">
          {(
            [
              { id: 'timeline' as const, label: 'Steps' },
              { id: 'charts' as const, label: 'Stats' },
              { id: 'insert' as const, label: '+' },
              { id: 'settings' as const, label: 'Data' },
            ] as const
          ).map((t) => {
            const activeTongue =
              t.id === 'insert'
                ? insertActive
                : navTab === t.id && !insertActive
            return (
              <button
                key={t.id}
                type="button"
                className={`book-tongue ${activeTongue ? 'book-tongue-on' : ''} ${
                  t.id === 'insert' ? 'book-tongue-plus' : ''
                } ${t.id === 'insert' && tempPin ? 'ring-2 ring-orange-400 ring-offset-1' : ''}`}
                onClick={() => {
                  if (
                    panelOpen &&
                    t.id !== 'insert' &&
                    navTab === t.id &&
                    !insertActive
                  ) {
                    setPanelOpen(false)
                    return
                  }
                  onTongue(t.id)
                }}
                title={
                  t.id === 'insert'
                    ? tempPin
                      ? 'Save map pin as step'
                      : 'Insert step'
                    : t.label
                }
              >
                {t.label}
              </button>
            )
          })}
        </nav>
      </aside>
      ) : null}

      {/* Phone: map-first — horizontal steps strip + bottom book tongues */}
      {isPhone ? (
        <div className="mobile-dock absolute inset-x-0 bottom-0 z-30 flex flex-col pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          {(panelOpen || exploreOpen) && lowerMode !== 'insert' ? (
            <div
              className={`mobile-panel relative mx-2 mb-1 flex flex-col overflow-hidden rounded-2xl border border-stone-200/90 shadow-[0_-8px_28px_rgba(15,23,42,0.28)] ${
                exploreOpen
                  ? exploreDetail
                    ? 'h-[min(62vh,26.5rem)]'
                    : 'h-[min(41vh,18.5rem)]'
                  : navTab === 'timeline'
                    ? 'max-h-[38vh]'
                    : navTab === 'settings' || navTab === 'charts'
                      ? 'h-[min(72vh,32rem)]'
                      : 'max-h-[52vh]'
              }`}
            >
              {exploreOpen ? (
                <div
                  className={
                    exploreDetail ? 'h-[min(62vh,26.5rem)]' : 'h-[min(41vh,18.5rem)]'
                  }
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
                    phone
                  />
                </div>
              ) : navTab === 'timeline' && active ? (
                <div className="px-2 pb-2 pt-2" data-coach="trip-steps">
                  <TimelinePanel
                    meta={active.meta}
                    items={active.items}
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
                    layout="horizontal"
                  />
                </div>
              ) : null}

              {!exploreOpen && navTab === 'charts' && active ? (
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] px-2 pb-2 pt-2"
                  onTouchStart={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                >
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
              ) : null}

              {!exploreOpen && navTab === 'settings' ? (
                <div
                  className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] px-3 pb-3 pt-2 text-sm text-stone-800"
                  onTouchStart={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                >
                  <DataPanel
                    active={active}
                    mapStack={mapStack}
                    googleKey={googleKey}
                    serverPlacesConfigured={serverPlacesConfigured}
                    ionToken={ionToken}
                    walkApp={walkApp}
                    enrichProgress={enrichProgress}
                    routesStatus={routesStatus}
                    onOpenExample={() => void onOpenExample()}
                    onBlank={() => void onBlank()}
                    onImportFile={(f) => void onImportFile(f)}
                    onExport={() => void onExport()}
                    onExportToDrive={() => void onExportToDrive()}
                    onImportFromDrive={(f) => void onImportFromDrive(f)}
                    onExportExampleExcel={() => void onExportExampleExcel()}
                    onEnrich={() => void onEnrich()}
                    onRebuildRoutes={() => {
                      if (!active) return
                      void buildRoutes(active)
                    }}
                    onAddDay={() => void addDay()}
                    onEditTrip={() => openTripEdit()}
                    onShowTips={() => openFeatureGuide({ all: true })}
                    onStatus={setStatus}
                    setMapStack={(id) => {
                      setMapStack(id)
                      void setSetting('mapStack', id)
                    }}
                    setWalkApp={(pref) => {
                      setWalkApp(pref)
                      void setSetting('walkApp', pref)
                    }}
                    setGoogleKey={setGoogleKey}
                    setIonToken={setIonToken}
                    updateActive={updateActive}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <nav className="book-tongues-bottom mx-2" aria-label="Phone navigation">
            {(
              [
                { id: 'timeline' as const, label: 'Steps' },
                { id: 'charts' as const, label: 'Stats' },
                { id: 'insert' as const, label: '+' },
                { id: 'settings' as const, label: 'Data' },
              ] as const
            ).map((t) => {
              const activeTongue =
                t.id === 'insert'
                  ? insertActive
                  : navTab === t.id && !insertActive && panelOpen
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`book-tongue-bottom ${activeTongue ? 'book-tongue-on' : ''} ${
                    t.id === 'insert' ? 'book-tongue-bottom-plus' : ''
                  } ${t.id === 'insert' && tempPin ? 'ring-2 ring-orange-400' : ''}`}
                  onClick={() => {
                    if (
                      panelOpen &&
                      t.id !== 'insert' &&
                      navTab === t.id &&
                      !insertActive
                    ) {
                      setPanelOpen(false)
                      return
                    }
                    onTongue(t.id)
                  }}
                  title={
                  t.id === 'insert'
                    ? tempPin
                      ? 'Save map pin as step'
                      : 'Insert step'
                    : t.label
                }
                >
                  {t.label}
                </button>
              )
            })}
          </nav>
        </div>
      ) : null}

      {/* Detail / Insert bottom sheet — covers steps on phone; tongues stay reachable */}
      {lowerOpen ? (
        <section
          className={`journal-sheet absolute inset-x-0 z-40 flex flex-col rounded-t-[1.75rem] border shadow-[0_-12px_40px_rgba(15,23,42,0.35)] transition-all ${
            isPhone ? 'bottom-[3.6rem]' : 'bottom-0'
          } ${
            lowerMode === 'insert'
              ? isPhone
                ? 'h-[70%]'
                : 'h-[62%]'
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
            {lowerMode === 'detail' && selected ? (
              <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
                <ItemDrawer
                  item={selected}
                  onClose={closeLower}
                  onChange={(item) => {
                    void updateActive((t) => ({
                      ...t,
                      items: sortItems(t.items.map((i) => (i.id === item.id ? item : i))),
                    }))
                  }}
                  onDelete={(id) => {
                    void deleteStep(id)
                  }}
                />
              </div>
            ) : null}

            {lowerMode === 'detail' && !selected ? (
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
        switches to the matching trip and overwrites it only when the Drive file is newer than your
        local copy. Open opens the folder or file in Google Drive. If an older save won’t open in
        Sheets, delete it and Save trip to Drive again.
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
  mapStack,
  googleKey,
  serverPlacesConfigured,
  ionToken,
  walkApp,
  enrichProgress,
  routesStatus,
  onOpenExample,
  onBlank,
  onImportFile,
  onExport,
  onExportToDrive,
  onImportFromDrive,
  onExportExampleExcel,
  onEnrich,
  onRebuildRoutes,
  onAddDay,
  onEditTrip,
  onShowTips,
  onStatus,
  setMapStack,
  setWalkApp,
  setGoogleKey,
  setIonToken,
  updateActive,
}: {
  active: TripRecord | null
  mapStack: MapStack
  googleKey: string
  serverPlacesConfigured: boolean
  ionToken: string
  walkApp: WalkAppPref
  enrichProgress: string | null
  routesStatus: string | null
  onOpenExample: () => void
  onBlank: () => void
  onImportFile: (f: File) => void
  onExport: () => void
  onExportToDrive: () => void
  onImportFromDrive: (file: DriveFileInfo) => void
  onExportExampleExcel: () => void
  onEnrich: () => void
  onRebuildRoutes: () => void
  onAddDay: () => void
  onEditTrip: () => void
  onShowTips: () => void
  onStatus: (msg: string) => void
  setMapStack: (id: MapStack) => void
  setWalkApp: (pref: WalkAppPref) => void
  setGoogleKey: (v: string) => void
  setIonToken: (v: string) => void
  updateActive: (mutator: (trip: TripRecord) => TripRecord) => Promise<void>
}) {
  return (
    <>
      <div className="rounded-2xl border border-sky-200 bg-sky-50/80 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">
          Feature tips
        </div>
        <p className="mt-1 text-xs text-stone-600">
          Short illustrated walkthrough for friends and family. New tips only appear once —
          reopen anytime from here or the Tips button.
        </p>
        <button type="button" className={`${btnPrimary} mt-2`} onClick={onShowTips}>
          Show tips
        </button>
      </div>

      <ActionRow>
        <button type="button" className={btnPrimary} onClick={onOpenExample}>
          Open example
        </button>
        <button type="button" className={btn} onClick={onBlank}>
          New trip
        </button>
      </ActionRow>

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
          Download example .xlsx
        </button>
      </ActionRow>

      <DriveSyncPanel
        active={active}
        onExportToDrive={onExportToDrive}
        onImportFromDrive={onImportFromDrive}
        onStatus={onStatus}
      />

      <button className={btnPrimary} onClick={onEnrich} disabled={!!enrichProgress}>
        Enrich pinpoints (Nominatim / Wikidata / OSRM)
      </button>
      <button className={btn} disabled={!!routesStatus || !active} onClick={onRebuildRoutes}>
        Rebuild drive + walk paths
      </button>

      <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
          Map stack
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['esri', 'Esri imagery'],
              ['osm', 'OpenStreetMap'],
              ['google3d', 'Google Photorealistic 3D'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`rounded-full px-3 py-1 text-xs ${
                mapStack === id
                  ? 'bg-[var(--coral)] text-white'
                  : 'border border-stone-200 bg-stone-50 text-stone-700'
              }`}
              onClick={() => setMapStack(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <div className="text-xs text-stone-500">🚶 figure opens</div>
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
                    ? 'bg-sky-600 text-white'
                    : 'border border-stone-200 bg-stone-50 text-stone-700'
                }`}
                onClick={() => setWalkApp(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-stone-400">
            Pins → Street View / Earth (nearest pano, no API key). Walk / drive / transit →
            directions. Flight paths → Google Flights (✈️).
          </p>
        </div>
        <label className="mt-3 block text-xs text-stone-500">
          Google Maps / Places key
          <input
            className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm text-stone-800"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={googleKey}
            onChange={(e) => setGoogleKey(sanitizeSecretInput(e.target.value))}
            onBlur={() => void setSetting('googleMapsKey', googleKey)}
            placeholder={
              serverPlacesConfigured
                ? 'Override server key…'
                : 'Paste key…'
            }
          />
          <span className="mt-1 block text-[10px] text-stone-400">
            {serverPlacesConfigured
              ? 'Leave blank to use the server key (GOOGLE_MAPS_API_KEY on Vercel). Paste your own here to override — saved only in this browser. Photoreal 3D needs a key here (browser Map Tiles).'
              : 'Optional override for Places. Prefer setting GOOGLE_MAPS_API_KEY on Vercel (server-only, not VITE_). Photoreal 3D tiles need a key pasted here.'}
          </span>
        </label>
        <label className="mt-3 block text-xs text-stone-500">
          Cesium ion token (optional terrain elevation)
          <input
            className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm text-stone-800"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ionToken}
            onChange={(e) => setIonToken(sanitizeSecretInput(e.target.value))}
            onBlur={() => void setSetting('cesiumIonToken', ionToken)}
            placeholder="Paste token…"
          />
          <span className="mt-1 block text-[10px] text-stone-400">
            Free at cesium.com/ion — stored locally in this browser only.
          </span>
        </label>
      </div>

      {active ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
            Trip meta
          </div>
          <button
            type="button"
            className={`${btn} mb-2 w-full justify-between`}
            onClick={onEditTrip}
          >
            <span className="truncate font-medium text-stone-800">{active.meta.name}</span>
            <span className="shrink-0 text-stone-400">
              {active.meta.startDate} → {active.meta.endDate}
            </span>
          </button>
          <button type="button" className={`${btn} mb-2 w-full`} onClick={onAddDay}>
            + Add a day (extends end date)
          </button>
          <label className="mb-2 block text-xs text-stone-500">
            Home currency (totals)
            <select
              className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm"
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
            className="w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5"
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
          <p className="mt-2 text-xs text-stone-500">
            Types: {ITEM_TYPES.join(', ')}. Excel uses Trip + Steps + Hotels + Cash — color-coded
            tables, cost heat, and Cash spend charts (Cash is export-only). Older Schedule workbooks
            still import.
          </p>
        </div>
      ) : null}

      <ClientLogsBlob />
    </>
  )
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

const btn =
  'cursor-pointer rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium leading-none text-stone-700 shadow-sm inline-flex items-center'
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
    <div className="rounded-2xl border border-stone-200 bg-stone-50/80 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
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
      <p className="mt-1 text-[10px] text-stone-400">
        Explore / Places / maps-status errors land here (secrets redacted).
      </p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-stone-200 bg-white p-2 font-mono text-[10px] leading-snug text-stone-700">
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
