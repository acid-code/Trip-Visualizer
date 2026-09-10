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
import { ensureDayStartBases, deleteStepAndPrune } from './data/dayBases'

type NavTab = 'timeline' | 'charts' | 'settings'
type LowerMode = 'none' | 'detail' | 'insert'

export default function App() {
  const [trips, setTrips] = useState<TripRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [navTab, setNavTab] = useState<NavTab>('timeline')
  const [panelOpen, setPanelOpen] = useState(true)
  const [lowerMode, setLowerMode] = useState<LowerMode>('none')
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
    const buf = await file.arrayBuffer()
    const { meta, items } = parseTripWorkbook(buf)
    const withBases = ensureDayStartBases(meta, items)
    setStatus(`Imported “${meta.name}” · looking up places on the map…`)
    const pinned = await pinTripItemsOnMap(withBases, (done, total) => {
      setStatus(`Pinning places ${done}/${total}…`)
    })
    const pinnedCount = pinned.filter(
      (item, i) =>
        (item.lat != null && item.lon != null && withBases[i]?.lat == null) ||
        (item.latTo != null && withBases[i]?.latTo == null),
    ).length
    const trip: TripRecord = {
      id: createId('TRIP'),
      meta,
      items: pinned,
      isExample: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await saveTrip(trip)
    await refresh()
    setActiveId(trip.id)
    setStatus(
      pinnedCount > 0
        ? `Imported “${meta.name}” · ${pinnedCount} place${pinnedCount === 1 ? '' : 's'} pinned on the map`
        : `Imported “${meta.name}”`,
    )
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

  function selectStep(id: string | null) {
    setSelectedId(id)
    if (id) {
      setNavTab('timeline')
      setLowerMode('detail')
      setPanelOpen(true)
      setAddContext(null)
    } else {
      setLowerMode((m) => (m === 'detail' ? 'none' : m))
    }
  }

  function closeLower() {
    setAddContext(null)
    setLowerMode((mode) => {
      if (mode === 'detail') setSelectedId(null)
      return 'none'
    })
  }

  async function addDay() {
    if (!active) return
    const base = active.meta.endDate || active.meta.startDate
    const d = new Date(base + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    const nextEnd = d.toISOString().slice(0, 10)
    const meta = {
      ...active.meta,
      endDate: nextEnd,
      startDate: active.meta.startDate || nextEnd,
    }
    const items = ensureDayStartBases(meta, active.items)
    await persist({ ...active, meta, items })
    setDayFilter(nextEnd)
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
    }
    if (dayFilter && dayFilter > meta.endDate) setDayFilter(null)
    setStatus('Step deleted')
    await buildRoutes(next)
  }

  function createStep(item: TripItem) {
    void (async () => {
      if (!active) return
      setStatus(`Pinning “${item.title}” on the map…`)
      const pinned = await pinItemOnMap(item)
      const nextItems = sortItems([...active.items, pinned])
      const next = { ...active, items: nextItems }
      await persist(next)
      setSelectedId(pinned.id)
      setAddContext(null)
      setNavTab('timeline')
      setLowerMode('detail')
      setPanelOpen(true)
      const onMap =
        pinned.lat != null && pinned.lon != null
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
      if (dayFilter && i.date !== dayFilter && i.endDate !== dayFilter) return false
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
          onSelect={selectStep}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-slate-400">Loading…</div>
      )}

      {/* Map-side header — stays clear of the left panel */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 p-3 pl-[min(24rem,90vw)] pt-[max(0.75rem,env(safe-area-inset-top))]">
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
        <div className="pointer-events-auto absolute right-3 top-[5.5rem] z-20 flex max-w-sm items-center justify-between gap-2 rounded-2xl border border-orange-300/40 bg-orange-500/90 px-3 py-2 text-xs text-white shadow-lg backdrop-blur">
          <span>Example trip — duplicate to keep a personal copy.</span>
          <button
            className="shrink-0 rounded-full bg-white px-3 py-1 font-semibold text-orange-700"
            onClick={() => void onDuplicate()}
          >
            Duplicate
          </button>
        </div>
      ) : null}

      {/* Google-style left sidebar + book tongues */}
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
                    onSelect={selectStep}
                    onDayFilter={setDayFilter}
                    onTypeFilter={setTypeFilter}
                    onInsertBetween={(after, before) => openInsert(after, before)}
                    onAddDay={() => void addDay()}
                    onDeleteStep={(id) => void deleteStep(id)}
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
                        meta: { ...t.meta, homeCurrency: code },
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

      {/* Detail / Insert bottom sheet (Google-style map + sheet) */}
      {lowerOpen ? (
        <section
          className={`journal-sheet absolute inset-x-0 bottom-0 z-40 flex flex-col rounded-t-[1.75rem] border shadow-[0_-12px_40px_rgba(15,23,42,0.35)] transition-all ${
            lowerMode === 'insert' ? 'h-[72%]' : 'h-[52%]'
          }`}
        >
          <button type="button" className="w-full pb-1 pt-1" onClick={closeLower}>
            <div className="sheet-handle" />
          </button>
          <div className="min-h-0 flex-1 overflow-hidden px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-stone-800">
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
            value={googleKey}
            onChange={(e) => setGoogleKey(e.target.value)}
            onBlur={() => void setSetting('googleMapsKey', googleKey)}
            placeholder="AIza…"
          />
        </label>
        <label className="mt-3 block text-xs text-stone-500">
          Cesium ion token (optional terrain elevation)
          <input
            className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm text-stone-800"
            value={ionToken}
            onChange={(e) => setIonToken(e.target.value)}
            onBlur={() => void setSetting('cesiumIonToken', ionToken)}
            placeholder="eyJ…"
          />
          <span className="mt-1 block text-[10px] text-stone-400">
            Free at cesium.com/ion — adds real terrain height to the globe.
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
            onChange={(e) =>
              void updateActive((t) => ({
                ...t,
                meta: { ...t.meta, name: e.target.value },
              }))
            }
          />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <label className="block text-xs text-stone-500">
              Start date
              <input
                className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm"
                type="date"
                value={active.meta.startDate}
                onChange={(e) =>
                  void updateActive((t) => ({
                    ...t,
                    meta: { ...t.meta, startDate: e.target.value },
                  }))
                }
              />
            </label>
            <label className="block text-xs text-stone-500">
              End date
              <input
                className="mt-1 w-full rounded-xl border border-stone-200 bg-stone-50 px-2 py-1.5 text-sm"
                type="date"
                value={active.meta.endDate}
                onChange={(e) =>
                  void updateActive((t) => ({
                    ...t,
                    meta: { ...t.meta, endDate: e.target.value },
                  }))
                }
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
                  meta: { ...t.meta, homeCurrency: e.target.value },
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
