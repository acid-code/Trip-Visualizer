import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TripItem, TripRecord } from './domain/types'
import { ITEM_TYPES } from './domain/types'
import {
  createBlankTrip,
  createId,
  duplicateTrip,
  ensureExampleTrip,
  getSetting,
  getTrip,
  listTrips,
  saveTrip,
  setSetting,
  sortItems,
} from './data/db'
import {
  buildTripWorkbook,
  downloadWorkbook,
  parseTripWorkbook,
  tripToBlankTemplate,
} from './data/excel'
import { enrichTripItems, pinItemOnMap, pinTripItemsOnMap } from './data/enrichment'
import {
  buildWalkingConnectors,
  hydrateDriveRoutes,
  type RouteConnector,
} from './data/routes'
import { GlobeView } from './ui/GlobeView'
import { TimelinePanel } from './ui/TimelinePanel'
import { ChartsPanel } from './ui/ChartsPanel'
import { ItemDrawer } from './ui/ItemDrawer'
import { AddStepPanel, type AddContext } from './ui/AddStepPanel'
import type { MapStack } from './globe/viewer'
import { EXAMPLE_TRIP_ID } from './data/examples/france-south-loop'
import { downloadPolarstepsJson } from './data/polarsteps'
import { ensureDayStartBases, deleteStepAndPrune, isPlaceholderBase, itemTouchesDay } from './data/dayBases'
import { normalizeCurrency } from './data/fx'
import {
  isIsoDate,
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
import { sanitizeTripRecord } from './domain/types'
import { useIsNarrow } from './ui/useIsNarrow'

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
  const [mapStack, setMapStack] = useState<MapStack>('esri')
  const [googleKey, setGoogleKey] = useState('')
  const [ionToken, setIonToken] = useState('')
  const [status, setStatus] = useState('')
  const [overviewToken, setOverviewToken] = useState(0)
  const [enrichProgress, setEnrichProgress] = useState<string | null>(null)
  const [connectors, setConnectors] = useState<RouteConnector[]>([])
  const [routesStatus, setRoutesStatus] = useState<string | null>(null)
  const [addContext, setAddContext] = useState<AddContext | null>(null)
  const routesForTripRef = useRef<string | null>(null)

  const active = useMemo(
    () => trips.find((t) => t.id === activeId) ?? null,
    [trips, activeId],
  )

  const selected = useMemo(
    () => active?.items.find((i) => i.id === selectedId) ?? null,
    [active, selectedId],
  )

  const refresh = useCallback(async () => {
    await ensureExampleTrip()
    const all = await listTrips()
    setTrips(all)
    setActiveId((prev) => prev ?? all.find((t) => t.isExample)?.id ?? all[0]?.id ?? null)
  }, [])

  useEffect(() => {
    void (async () => {
      await refresh()
      setGoogleKey((await getSetting('googleMapsKey')) ?? '')
      setIonToken((await getSetting('cesiumIonToken')) ?? '')
      setMapStack(((await getSetting('mapStack')) as MapStack) || 'esri')
    })()
  }, [refresh])

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

  async function onImportFile(file: File) {
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setStatus('Import failed — file is too large (max 5 MB)')
        return
      }
      const buf = await file.arrayBuffer()
      const { meta, items } = parseTripWorkbook(buf)
      const dates = sanitizeMetaDates(meta.startDate, meta.endDate)
      const safeMeta = {
        ...meta,
        name: meta.name.trim() || 'Imported trip',
        ...dates,
      }
      const withBases = ensureDayStartBases(safeMeta, items)
      setStatus(`Imported “${safeMeta.name}” · looking up places on the map…`)
      const pinned = await pinTripItemsOnMap(withBases, (done, total) => {
        setStatus(`Pinning places ${done}/${total}…`)
      })
      const pinnedCount = pinned.filter(
        (item, i) =>
          (isValidCoord(item.lat, item.lon) && !isValidCoord(withBases[i]?.lat, withBases[i]?.lon)) ||
          (isValidCoord(item.latTo, item.lonTo) &&
            !isValidCoord(withBases[i]?.latTo, withBases[i]?.lonTo)),
      ).length
      const trip = sanitizeTripRecord({
        id: createId('TRIP'),
        meta: safeMeta,
        items: pinned,
        isExample: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await saveTrip(trip)
      await refresh()
      setActiveId(trip.id)
      setStatus(
        pinnedCount > 0
          ? `Imported “${safeMeta.name}” · ${pinnedCount} place${pinnedCount === 1 ? '' : 's'} pinned on the map`
          : `Imported “${safeMeta.name}”`,
      )
    } catch (err) {
      logClientError('import', err)
      setStatus(
        publicErrorMessage(
          err,
          'Import failed — use a Trip Tracker Excel with a Schedule sheet',
        ),
      )
    }
  }

  async function onExport() {
    if (!active) return
    downloadWorkbook(buildTripWorkbook(active), `${slug(active.meta.name)}.xlsx`)
    setStatus('Excel downloaded')
  }

  async function onExportTemplate() {
    downloadWorkbook(tripToBlankTemplate(), 'trip-template.xlsx')
  }

  async function onExportExampleExcel() {
    const example = await getTrip(EXAMPLE_TRIP_ID)
    if (!example) return
    downloadWorkbook(buildTripWorkbook(example), 'france-south-loop.xlsx')
  }

  async function onOpenExample() {
    const example = await ensureExampleTrip()
    setActiveId(example.id)
    setOverviewToken((n) => n + 1)
    setStatus('Opened example trip')
  }

  async function onDuplicate() {
    if (!active) return
    const copy = await duplicateTrip(active)
    await refresh()
    setActiveId(copy.id)
    setStatus('Duplicated as editable trip')
  }

  async function onBlank() {
    const trip = await createBlankTrip()
    await refresh()
    setActiveId(trip.id)
  }

  async function buildRoutes(trip: TripRecord) {
    setRoutesStatus('Drawing drive paths…')
    const withDrives = await hydrateDriveRoutes(trip.items, (done, total) => {
      setRoutesStatus(`Drive paths ${done}/${total}`)
    })
    setRoutesStatus('Walking links between same-day steps…')
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
      setLowerMode((m) => (m === 'detail' ? 'none' : m))
      setDetailExpanded(false)
      return
    }
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

  /** Map pin tap — highlight only (Detail opens from the Steps list). */
  function selectFromMap(id: string | null) {
    highlightStep(id)
  }

  /** Second tap on an already-highlighted step — opens Detail (or fill form for placeholders). */
  function selectFromList(id: string) {
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

  function onTongue(id: NavTab | 'insert') {
    setPanelOpen(true)
    if (id === 'insert') {
      openInsert(null, null)
      return
    }
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

  const lowerOpen = lowerMode !== 'none'
  const insertActive = lowerMode === 'insert'

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0c1520] text-slate-100">
      {active ? (
        <GlobeView
          items={filteredItems.length ? filteredItems : active.items}
          meta={active.meta}
          connectors={visibleConnectors}
          selectedId={selectedId}
          mapStack={mapStack}
          googleKey={googleKey || undefined}
          ionToken={ionToken || undefined}
          overviewToken={overviewToken}
          onSelect={selectFromMap}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-slate-400">Loading…</div>
      )}

      {/* Map-side header — desktop clears left panel; phone uses compact top bar */}
      <header
        className={`pointer-events-none absolute inset-x-0 top-0 z-20 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] ${
          isPhone ? 'pl-3' : 'pl-[min(24rem,90vw)]'
        }`}
      >
        <div className="pointer-events-auto ml-auto flex max-w-md flex-col items-end gap-1">
          <div className="text-right">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-orange-300/90">
              Trip journal
            </div>
            <h1 className="brand-mark truncate text-xl text-white drop-shadow">
              {active?.meta.name ?? '…'}
            </h1>
            <p className="text-xs text-white/70 drop-shadow">
              {active?.meta.startDate} → {active?.meta.endDate}
              {active?.isExample ? ' · example' : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <select
              className="max-w-44 rounded-full border border-white/20 bg-black/45 px-3 py-1.5 text-xs text-white backdrop-blur"
              value={activeId ?? ''}
              onChange={(e) => setActiveId(e.target.value)}
            >
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.isExample ? '★ ' : ''}
                  {t.meta.name}
                </option>
              ))}
            </select>
            <button
              className="rounded-full bg-white/15 px-3 py-1 text-xs text-white backdrop-blur hover:bg-white/25"
              onClick={() => setOverviewToken((n) => n + 1)}
            >
              Overview
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

      {active?.isExample ? (
        <div
          className={`pointer-events-auto absolute right-3 z-20 flex max-w-sm items-center justify-between gap-2 rounded-2xl border border-orange-300/40 bg-orange-500/90 px-3 py-2 text-xs text-white shadow-lg backdrop-blur ${
            isPhone ? 'top-[4.75rem]' : 'top-[5.5rem]'
          }`}
        >
          <span>Example trip — duplicate to keep a personal copy.</span>
          <button
            className="shrink-0 rounded-full bg-white px-3 py-1 font-semibold text-orange-700"
            onClick={() => void onDuplicate()}
          >
            Duplicate
          </button>
        </div>
      ) : null}

      {/* Desktop: left sidebar + side book tongues */}
      {!isPhone ? (
      <aside
        className={`side-shell absolute bottom-0 left-0 top-0 z-30 flex pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] ${
          panelOpen ? 'side-shell-open' : 'side-shell-collapsed'
        }`}
      >
        {panelOpen ? (
          <div className="side-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                <div className="h-full min-h-0 px-2 pb-2 pt-1">
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
                    ionToken={ionToken}
                    enrichProgress={enrichProgress}
                    routesStatus={routesStatus}
                    onOpenExample={() => void onOpenExample()}
                    onDuplicate={() => void onDuplicate()}
                    onBlank={() => void onBlank()}
                    onImportFile={(f) => void onImportFile(f)}
                    onExport={() => void onExport()}
                    onExportExampleExcel={() => void onExportExampleExcel()}
                    onExportTemplate={() => void onExportTemplate()}
                    onPolarsteps={() => {
                      if (!active) return
                      downloadPolarstepsJson(active)
                      setStatus('Polarsteps-compatible JSON downloaded')
                    }}
                    onEnrich={() => void onEnrich()}
                    onRebuildRoutes={() => {
                      if (!active) return
                      void buildRoutes(active)
                    }}
                    onAddDay={() => void addDay()}
                    setMapStack={(id) => {
                      setMapStack(id)
                      void setSetting('mapStack', id)
                    }}
                    setGoogleKey={setGoogleKey}
                    setIonToken={setIonToken}
                    updateActive={updateActive}
                  />
                </div>
              ) : null}
            </div>
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
                }`}
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
                title={t.id === 'insert' ? 'Insert step' : t.label}
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
          {panelOpen && lowerMode !== 'insert' ? (
            <div
              className={`mobile-panel mx-2 mb-1 overflow-hidden rounded-2xl border border-stone-200/90 shadow-[0_-8px_28px_rgba(15,23,42,0.28)] ${
                navTab === 'timeline'
                  ? 'max-h-[38vh]'
                  : 'max-h-[52vh]'
              }`}
            >
              {navTab === 'timeline' && active ? (
                <div className="px-2 pb-2 pt-2">
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

              {navTab === 'charts' && active ? (
                <div className="max-h-[52vh] overflow-y-auto overscroll-contain px-2 pb-2 pt-2">
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
                <div className="max-h-[52vh] space-y-3 overflow-y-auto overscroll-contain px-3 pb-3 pt-2 text-sm text-stone-800">
                  <DataPanel
                    active={active}
                    mapStack={mapStack}
                    googleKey={googleKey}
                    ionToken={ionToken}
                    enrichProgress={enrichProgress}
                    routesStatus={routesStatus}
                    onOpenExample={() => void onOpenExample()}
                    onDuplicate={() => void onDuplicate()}
                    onBlank={() => void onBlank()}
                    onImportFile={(f) => void onImportFile(f)}
                    onExport={() => void onExport()}
                    onExportExampleExcel={() => void onExportExampleExcel()}
                    onExportTemplate={() => void onExportTemplate()}
                    onPolarsteps={() => {
                      if (!active) return
                      downloadPolarstepsJson(active)
                      setStatus('Polarsteps-compatible JSON downloaded')
                    }}
                    onEnrich={() => void onEnrich()}
                    onRebuildRoutes={() => {
                      if (!active) return
                      void buildRoutes(active)
                    }}
                    onAddDay={() => void addDay()}
                    setMapStack={(id) => {
                      setMapStack(id)
                      void setSetting('mapStack', id)
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
                  }`}
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
                  title={t.id === 'insert' ? 'Insert step' : t.label}
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
    </div>
  )
}

function DataPanel({
  active,
  mapStack,
  googleKey,
  ionToken,
  enrichProgress,
  routesStatus,
  onOpenExample,
  onDuplicate,
  onBlank,
  onImportFile,
  onExport,
  onExportExampleExcel,
  onExportTemplate,
  onPolarsteps,
  onEnrich,
  onRebuildRoutes,
  onAddDay,
  setMapStack,
  setGoogleKey,
  setIonToken,
  updateActive,
}: {
  active: TripRecord | null
  mapStack: MapStack
  googleKey: string
  ionToken: string
  enrichProgress: string | null
  routesStatus: string | null
  onOpenExample: () => void
  onDuplicate: () => void
  onBlank: () => void
  onImportFile: (f: File) => void
  onExport: () => void
  onExportExampleExcel: () => void
  onExportTemplate: () => void
  onPolarsteps: () => void
  onEnrich: () => void
  onRebuildRoutes: () => void
  onAddDay: () => void
  setMapStack: (id: MapStack) => void
  setGoogleKey: (v: string) => void
  setIonToken: (v: string) => void
  updateActive: (mutator: (trip: TripRecord) => TripRecord) => Promise<void>
}) {
  return (
    <>
      <ActionRow>
        <button className={btnPrimary} onClick={onOpenExample}>
          Open example trip
        </button>
        <button className={btn} onClick={onDuplicate}>
          Duplicate as my trip
        </button>
        <button className={btn} onClick={onBlank}>
          New blank trip
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
        <button className={btn} onClick={onExport}>
          Export Excel
        </button>
        <button className={btn} onClick={onExportExampleExcel}>
          Download example .xlsx
        </button>
        <button className={btn} onClick={onExportTemplate}>
          Download blank template
        </button>
      </ActionRow>

      <div className="rounded-2xl border border-orange-200 bg-orange-50/80 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-orange-700">
          Polarsteps bridge
        </div>
        <p className="mt-1 text-xs text-stone-600">
          Polarsteps has no public import API yet. Export a{' '}
          <code className="rounded bg-white px-1">trip.json</code>-compatible file now so you can
          move steps later (or feed a future sync).
        </p>
        <button className={`${btnPrimary} mt-2`} disabled={!active} onClick={onPolarsteps}>
          Export Polarsteps JSON
        </button>
      </div>

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
              ['esri', 'Esri imagery (free)'],
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
        <label className="mt-3 block text-xs text-stone-500">
          Google Maps key (optional, for photoreal 3D)
          <input
            className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm text-stone-800"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={googleKey}
            onChange={(e) => setGoogleKey(sanitizeSecretInput(e.target.value))}
            onBlur={() => void setSetting('googleMapsKey', googleKey)}
            placeholder="Paste key…"
          />
          <span className="mt-1 block text-[10px] text-stone-400">
            Stored only in this browser’s IndexedDB — never committed or sent to our servers.
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
          <input
            className="mb-2 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5"
            value={active.meta.name}
            onChange={(e) => {
              const name = e.target.value
              void updateActive((t) => ({
                ...t,
                meta: { ...t.meta, name },
              }))
            }}
            onBlur={(e) => {
              const name = e.target.value.trim() || 'Untitled trip'
              void updateActive((t) => ({
                ...t,
                meta: { ...t.meta, name },
              }))
            }}
          />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <label className="block text-xs text-stone-500">
              Start date
              <input
                className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm"
                type="date"
                value={isIsoDate(active.meta.startDate) ? active.meta.startDate : ''}
                required
                onChange={(e) => {
                  if (!e.target.value) return
                  const dates = sanitizeMetaDates(e.target.value, active.meta.endDate)
                  void updateActive((t) => ({
                    ...t,
                    meta: { ...t.meta, ...dates },
                  }))
                }}
              />
            </label>
            <label className="block text-xs text-stone-500">
              End date
              <input
                className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm"
                type="date"
                value={isIsoDate(active.meta.endDate) ? active.meta.endDate : ''}
                min={
                  isIsoDate(active.meta.startDate) ? active.meta.startDate : undefined
                }
                required
                onChange={(e) => {
                  if (!e.target.value) return
                  const dates = sanitizeMetaDates(active.meta.startDate, e.target.value)
                  void updateActive((t) => ({
                    ...t,
                    meta: { ...t.meta, ...dates },
                  }))
                }}
              />
            </label>
          </div>
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
          />
          <p className="mt-2 text-xs text-stone-500">
            Types: {ITEM_TYPES.join(', ')}. Schedule-first Excel uses Trip + Schedule + Legend
            sheets.
          </p>
        </div>
      ) : null}
    </>
  )
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

const btn =
  'cursor-pointer rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 shadow-sm'
const btnPrimary =
  'rounded-full bg-[var(--coral)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50'

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'trip'
}
