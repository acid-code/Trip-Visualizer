import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanPlace, PlanSection, TripRecord } from '../domain/types'
import { listTripDays } from '../data/dayBases'
import {
  addPlanPlace,
  dayTravelLegs,
  JOURNEY_SECTION_TITLE,
  optimizeDayRoute,
  promotePlanPlaceToStep,
  removePlanPlace,
  unschedulePlanPlace,
} from '../data/planBoard'
import { REGION_PACKS, findRegionPack } from '../data/regionPacks'
import { createId } from '../data/db'
import {
  exploreCategoryLabel,
  fetchNearbyExplore,
  filterAndSortExplore,
  type ExploreCategory,
  type ExplorePlace,
} from '../data/explore'
import { isValidCoord } from '../data/validate'
import { PlanMapView } from '../map/PlanMapView'
import { Chip, IconButton, SegmentedControl } from './primitives'
import { TOUCH_SCROLL_X, TOUCH_SCROLL_Y } from './scrollGesture'

type Props = {
  trip: TripRecord
  onChange: (next: TripRecord) => void
  onAskAi?: (prompt: string) => void
  /** Prefer Google Nearby when Places is configured. */
  placesEnabled?: boolean
  googleApiKey?: string
  /** Surface short status (e.g. synced to Journey). */
  onStatus?: (msg: string) => void
}

type PlanMode = 'discover' | 'days'

const SUGGEST_CATS: Array<{ id: ExploreCategory; short: string }> = [
  { id: 'food', short: 'Food' },
  { id: 'drink', short: 'Drinks' },
  { id: 'sights', short: 'Sights' },
  { id: 'hotel', short: 'Hotels' },
  { id: 'nature', short: 'Nature' },
]

function tripMapAnchor(trip: TripRecord): { lat: number; lon: number } {
  const pts: Array<{ lat: number; lon: number }> = []
  for (const p of trip.planPlaces) {
    if (isValidCoord(p.lat, p.lon)) pts.push({ lat: p.lat!, lon: p.lon! })
  }
  for (const i of trip.items) {
    if (isValidCoord(i.lat, i.lon)) pts.push({ lat: i.lat!, lon: i.lon! })
    if (isValidCoord(i.latTo, i.lonTo)) pts.push({ lat: i.latTo!, lon: i.lonTo! })
  }
  if (!pts.length) return { lat: 43.7, lon: 5.2 }
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length
  return { lat, lon }
}

function sectionForExploreCategory(
  trip: TripRecord,
  cat: ExploreCategory,
): PlanSection | undefined {
  const want =
    cat === 'food' || cat === 'drink'
      ? 'food'
      : cat === 'hotel'
        ? 'stay'
        : cat === 'nature' || cat === 'sights'
          ? 'must'
          : 'maybe'
  return trip.planSections.find((s) => {
    const t = s.title.toLowerCase()
    if (want === 'food') return t.includes('food') || t.includes('eat')
    if (want === 'stay') return t.includes('stay') || t.includes('hotel')
    if (want === 'must') return t.includes('must') || t.includes('sight')
    return t.includes('maybe') || t.includes('optional')
  })
}

/**
 * Wanderlog-style Plan: Discover (lists + suggestions) | Days (itinerary).
 * Map is always the canvas; sheet peeks from the bottom.
 */
export function PlanBoard({
  trip,
  onChange,
  onAskAi,
  placesEnabled = false,
  googleApiKey,
  onStatus,
}: Props) {
  const days = listTripDays(trip.meta)
  const [mode, setMode] = useState<PlanMode>('discover')
  const [activeDay, setActiveDay] = useState(days[0] ?? '')
  const [activeSectionId, setActiveSectionId] = useState(
    trip.planSections.find((s) => s.title !== JOURNEY_SECTION_TITLE)?.id ??
      trip.planSections[0]?.id ??
      '',
  )
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(new Set())
  const [suggestCat, setSuggestCat] = useState<ExploreCategory>('sights')
  const [suggestions, setSuggestions] = useState<ExplorePlace[]>([])
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [focusPlaceId, setFocusPlaceId] = useState<string | null>(null)
  const [focusSuggestionId, setFocusSuggestionId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [packsOpen, setPacksOpen] = useState(false)
  const suggestAbortRef = useRef<AbortController | null>(null)

  const daySafe = days.includes(activeDay) ? activeDay : (days[0] ?? '')

  const listSections = useMemo(
    () =>
      trip.planSections.filter(
        (s) =>
          s.title !== JOURNEY_SECTION_TITLE &&
          s.title.toLowerCase() !== 'journey' &&
          s.title.toLowerCase() !== 'on the trip',
      ),
    [trip.planSections],
  )

  const visibleSectionIds = useMemo(() => {
    const ids = new Set(trip.planSections.map((s) => s.id))
    for (const id of hiddenSections) ids.delete(id)
    return ids
  }, [trip.planSections, hiddenSections])

  const mapVisibleDays = useMemo(() => {
    if (mode !== 'days' || !daySafe) return null
    return new Set([daySafe])
  }, [mode, daySafe])

  const unscheduled = trip.planPlaces.filter((p) => !p.scheduledDay)
  const bySection = (sectionId: string) =>
    unscheduled.filter((p) => p.sectionId === sectionId)

  const filteredSuggestions = useMemo(
    () => filterAndSortExplore(suggestions, suggestCat, 'distance'),
    [suggestions, suggestCat],
  )

  const suggestionPins = useMemo(
    () =>
      mode === 'discover'
        ? filteredSuggestions.map((p) => ({
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            name: p.name,
          }))
        : [],
    [mode, filteredSuggestions],
  )

  const dayPlaces =
    !daySafe
      ? []
      : trip.planPlaces
          .filter((p) => p.scheduledDay === daySafe)
          .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))

  const legs = daySafe ? dayTravelLegs(trip, daySafe) : []
  const dayIdx = daySafe ? days.indexOf(daySafe) : -1
  const totalKm = legs.reduce((s, l) => s + (l?.km ?? 0), 0)
  const totalMin = legs.reduce((s, l) => s + (l?.minutes ?? 0), 0)

  useEffect(() => {
    if (mode !== 'discover') return
    const anchor = tripMapAnchor(trip)
    suggestAbortRef.current?.abort()
    const ac = new AbortController()
    suggestAbortRef.current = ac
    setSuggestBusy(true)
    setSuggestError(null)
    void (async () => {
      try {
        const places = await fetchNearbyExplore(anchor, {
          signal: ac.signal,
          useGooglePlaces: placesEnabled,
          googleApiKey: googleApiKey || undefined,
          categories: [suggestCat],
          radiusM: 4000,
          limit: placesEnabled ? 20 : 36,
          onCacheHit: (cached) => {
            if (!ac.signal.aborted) {
              setSuggestions(cached)
              setSuggestBusy(false)
            }
          },
        })
        if (ac.signal.aborted) return
        setSuggestions(places)
        if (!places.length) setSuggestError('No suggestions nearby — pan the trip pins or try another type')
        else setSuggestError(null)
      } catch (err) {
        if (ac.signal.aborted) return
        setSuggestError(err instanceof Error ? err.message : 'Could not load suggestions')
      } finally {
        if (!ac.signal.aborted) setSuggestBusy(false)
      }
    })()
    return () => ac.abort()
    // Re-fetch when mode/category/places toggle changes; anchor follows trip id + place count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, suggestCat, placesEnabled, googleApiKey, trip.id, trip.planPlaces.length, trip.items.length])

  function toggleSectionLayer(id: string) {
    setHiddenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addIdea() {
    const sectionId = activeSectionId || listSections[0]?.id
    if (!sectionId || !draftName.trim()) return
    onChange(addPlanPlace(trip, { sectionId, name: draftName.trim() }))
    setDraftName('')
  }

  function saveSuggestion(place: ExplorePlace) {
    const section =
      trip.planSections.find((s) => s.id === activeSectionId) ||
      sectionForExploreCategory(trip, place.category) ||
      listSections[0]
    if (!section) return
    const dup = trip.planPlaces.some(
      (p) =>
        p.name.toLowerCase() === place.name.toLowerCase() &&
        Math.abs((p.lat ?? 0) - place.lat) < 0.0008 &&
        Math.abs((p.lon ?? 0) - place.lon) < 0.0008,
    )
    if (dup) {
      onStatus?.(`“${place.name}” is already on your lists`)
      return
    }
    onChange(
      addPlanPlace(trip, {
        sectionId: section.id,
        name: place.name,
        place: place.address || place.name,
        city: '',
        lat: place.lat,
        lon: place.lon,
        notes: place.summary || place.cuisine || '',
        googleMapsUri: place.tags.googleMapsUri || '',
        osmId: place.id.startsWith('osm:') ? place.id : '',
      }),
    )
    setFocusSuggestionId(null)
    onStatus?.(`Saved “${place.name}” to ${section.title}`)
  }

  function schedulePlace(placeId: string, day: string) {
    onChange(promotePlanPlaceToStep(trip, placeId, day))
    setMode('days')
    setActiveDay(day)
    const idx = days.indexOf(day)
    onStatus?.(
      `Added to Day ${idx >= 0 ? idx + 1 : day.slice(5)} · synced to Journey`,
    )
  }

  function applyPack(packId: string) {
    const pack = findRegionPack(packId)
    if (!pack) return
    let next = trip
    for (const p of pack.places) {
      let section = next.planSections.find(
        (s) => s.title.toLowerCase() === p.section.toLowerCase(),
      )
      if (!section) {
        section = {
          id: createId('SEC'),
          title: p.section,
          color: '#60a5fa',
          icon: '📍',
          order: next.planSections.length,
        }
        next = { ...next, planSections: [...next.planSections, section] }
      }
      next = addPlanPlace(next, {
        sectionId: section.id,
        name: p.name,
        city: p.city,
        lat: p.lat,
        lon: p.lon,
        notes: p.notes,
      })
    }
    onChange(next)
    setMode('discover')
    setPacksOpen(false)
    onStatus?.(`Added ideas from ${pack.label}`)
  }

  return (
    <div className="plan-phone relative flex h-full min-h-0 flex-col">
      {/* Top chrome — left side only so Journey/Plan switcher stays clear */}
      <div className="plan-phone-top pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pt-[max(0.55rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex max-w-[calc(100%-9.5rem)] flex-col gap-2">
          <SegmentedControl
            ariaLabel="Plan mode"
            value={mode}
            onChange={setMode}
            options={[
              { id: 'discover', label: 'Discover' },
              { id: 'days', label: 'Days' },
            ]}
          />
          {mode === 'discover' ? (
            <div className={`flex gap-1.5 pb-0.5 ${TOUCH_SCROLL_X}`}>
              {SUGGEST_CATS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`plan-day-chip shrink-0 ${suggestCat === c.id ? 'plan-day-chip-on' : ''}`}
                  onClick={() => setSuggestCat(c.id)}
                >
                  {c.short}
                </button>
              ))}
            </div>
          ) : (
            <div className={`flex gap-1.5 pb-0.5 ${TOUCH_SCROLL_X}`}>
              {days.map((day, idx) => (
                <button
                  key={day}
                  type="button"
                  className={`plan-day-chip shrink-0 ${daySafe === day ? 'plan-day-chip-on' : ''}`}
                  onClick={() => setActiveDay(day)}
                >
                  Day {idx + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Map always on */}
      <div className="absolute inset-0 z-0">
        <PlanMapView
          meta={trip.meta}
          sections={trip.planSections}
          places={trip.planPlaces}
          visibleSectionIds={visibleSectionIds}
          visibleDays={mapVisibleDays}
          colorBy={mode === 'days' ? 'day' : 'section'}
          hideScheduled={mode === 'discover'}
          suggestions={suggestionPins}
          focusPlaceId={focusPlaceId}
          focusSuggestionId={focusSuggestionId}
          onPlaceClick={(id) => {
            setFocusPlaceId(id)
            setFocusSuggestionId(null)
          }}
          onSuggestionClick={(id) => {
            setFocusSuggestionId(id)
            setFocusPlaceId(null)
          }}
          className="h-full"
        />
      </div>

      {/* Bottom sheet */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-[min(58vh,28rem)] flex-col pt-[6.75rem]">
        <div
          className={`plan-itin-sheet pointer-events-auto mx-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[1.75rem] ${TOUCH_SCROLL_Y}`}
        >
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--ink-muted)]/35" />

          {mode === 'discover' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
              <div className="flex items-end justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                    Discover
                  </h2>
                  <p className="text-[12px] text-[var(--ink-muted)]">
                    Save map ideas to lists, then schedule them on Days.
                  </p>
                </div>
                <Chip on={packsOpen} onClick={() => setPacksOpen((v) => !v)}>
                  Packs
                </Chip>
              </div>

              {packsOpen ? (
                <div className={`flex gap-1.5 ${TOUCH_SCROLL_X}`}>
                  {REGION_PACKS.map((pack) => (
                    <Chip key={pack.id} onClick={() => applyPack(pack.id)} title={pack.country}>
                      + {pack.label}
                    </Chip>
                  ))}
                </div>
              ) : null}

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                    Nearby {exploreCategoryLabel(suggestCat)}
                    {suggestBusy ? ' · …' : ''}
                  </p>
                  <span className="text-[10px] tabular-nums text-[var(--ink-muted)]">
                    {filteredSuggestions.length}
                  </span>
                </div>
                {suggestError ? (
                  <p className="mb-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11px] text-[color-mix(in_srgb,#e11d48_85%,var(--ink))]">
                    {suggestError}
                  </p>
                ) : null}
                <div className={`flex gap-2 pb-1 ${TOUCH_SCROLL_X}`}>
                  {filteredSuggestions.slice(0, 24).map((p) => (
                    <div
                      key={p.id}
                      className={`plan-suggest-card shrink-0 ${
                        focusSuggestionId === p.id ? 'plan-suggest-card-on' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => {
                          setFocusSuggestionId(p.id)
                          setFocusPlaceId(null)
                        }}
                      >
                        <span className="line-clamp-2 text-[12px] font-semibold text-[var(--ink)]">
                          {p.name}
                        </span>
                        <span className="mt-1 block text-[10px] text-[var(--ink-muted)]">
                          {p.distKm < 1
                            ? `${Math.round(p.distKm * 1000)} m`
                            : `${p.distKm.toFixed(1)} km`}
                          {p.rating != null ? ` · ★ ${p.rating}` : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="mt-2 rounded-full bg-[var(--coral)] px-2 py-0.5 text-[10px] font-semibold text-white"
                        onClick={() => saveSuggestion(p)}
                      >
                        Save
                      </button>
                    </div>
                  ))}
                  {!suggestBusy && !filteredSuggestions.length ? (
                    <p className="px-1 py-4 text-[12px] text-[var(--ink-muted)]">
                      No pins yet — try another type or add a place to the trip first.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {listSections.map((section) => (
                  <Chip
                    key={section.id}
                    on={!hiddenSections.has(section.id)}
                    onClick={() => toggleSectionLayer(section.id)}
                    title="Toggle on map"
                  >
                    {section.icon} {section.title}
                  </Chip>
                ))}
              </div>

              {listSections.map((section) => (
                <ListSection
                  key={section.id}
                  section={section}
                  places={bySection(section.id)}
                  active={activeSectionId === section.id}
                  hidden={hiddenSections.has(section.id)}
                  days={days}
                  onSelect={() => setActiveSectionId(section.id)}
                  onFocus={setFocusPlaceId}
                  onSchedule={schedulePlace}
                  onRemove={(placeId) => onChange(removePlanPlace(trip, placeId))}
                />
              ))}

              <div className="plan-card">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                  Add to{' '}
                  {trip.planSections.find((s) => s.id === activeSectionId)?.title || 'list'}
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addIdea()
                    }}
                    placeholder="Place name…"
                    className="plan-input"
                  />
                  <IconButton onClick={addIdea} disabled={!draftName.trim()}>
                    Add
                  </IconButton>
                </div>
              </div>

              {onAskAi ? (
                <div className="plan-card plan-card-ai">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300/90">
                    Ask Plan AI
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="e.g. fill Food for Provence…"
                      className="plan-input"
                    />
                    <IconButton
                      className="border-violet-400/40 text-violet-200"
                      onClick={() => {
                        if (!aiPrompt.trim()) return
                        onAskAi(aiPrompt.trim())
                        setAiPrompt('')
                      }}
                    >
                      Ask
                    </IconButton>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                    Day {dayIdx + 1}
                  </h2>
                  <p className="text-[12px] text-[var(--ink-muted)]">
                    {daySafe}
                    {dayPlaces.length
                      ? ` · ${dayPlaces.length} stop${dayPlaces.length === 1 ? '' : 's'}`
                      : ''}
                    {totalKm > 0 ? ` · ${totalKm.toFixed(0)} km · ~${totalMin} min` : ''}
                  </p>
                </div>
                <IconButton
                  title="Optimize route"
                  disabled={dayPlaces.length < 2}
                  onClick={() =>
                    daySafe && onChange(optimizeDayRoute(trip, daySafe))
                  }
                >
                  Optimize
                </IconButton>
              </div>

              <div className={`min-h-0 flex-1 space-y-0 ${TOUCH_SCROLL_Y}`}>
                {dayPlaces.map((p, i) => (
                  <div key={p.id}>
                    <div className="plan-stop-row">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setFocusPlaceId(p.id)}
                      >
                        <span className="plan-stop-num">{i + 1}</span>
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate text-[15px] font-medium text-[var(--ink)]">
                            {p.name}
                          </span>
                          {p.city ? (
                            <span className="block truncate text-[11px] text-[var(--ink-muted)]">
                              {p.city}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="shrink-0 px-1 text-[11px] font-semibold text-rose-300/90"
                        onClick={() => onChange(unschedulePlanPlace(trip, p.id))}
                      >
                        Remove
                      </button>
                    </div>
                    {legs[i] ? (
                      <div className="plan-leg">
                        <span className="plan-leg-line" />
                        <span>
                          {legs[i]!.km} km · ~{legs[i]!.minutes} min
                        </span>
                      </div>
                    ) : null}
                  </div>
                ))}

                {!dayPlaces.length ? (
                  <div className="rounded-2xl border border-dashed border-[var(--glass-border)] px-4 py-10 text-center">
                    <p className="text-[15px] font-medium text-[var(--ink)]">No stops yet</p>
                    <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                      Save ideas in Discover, then add them to this day.
                    </p>
                    <button
                      type="button"
                      className="mt-4 rounded-full bg-[var(--coral)] px-4 py-2 text-xs font-semibold text-white"
                      onClick={() => setMode('discover')}
                    >
                      Open Discover
                    </button>
                  </div>
                ) : null}
              </div>

              {unscheduled.length > 0 && daySafe ? (
                <div className="mt-3 border-t border-[var(--glass-border)] pt-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                    Add from Lists
                  </p>
                  <div className={`flex gap-1.5 ${TOUCH_SCROLL_X}`}>
                    {unscheduled.slice(0, 16).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="plan-map-stop shrink-0"
                        onClick={() => schedulePlace(p.id, daySafe)}
                      >
                        + {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ListSection({
  section,
  places,
  active,
  hidden,
  days,
  onSelect,
  onFocus,
  onSchedule,
  onRemove,
}: {
  section: PlanSection
  places: PlanPlace[]
  active: boolean
  hidden: boolean
  days: string[]
  onSelect: () => void
  onFocus: (id: string) => void
  onSchedule: (placeId: string, day: string) => void
  onRemove: (placeId: string) => void
}) {
  return (
    <section
      className={`plan-card ${active ? 'ring-1 ring-[var(--coral)]/45' : ''} ${
        hidden ? 'opacity-50' : ''
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="mb-2 flex w-full items-center gap-2 text-left"
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full text-sm"
          style={{ background: `${section.color}33`, color: section.color }}
        >
          {section.icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ink)]">
          {section.title}
        </span>
        <span className="text-[11px] text-[var(--ink-muted)]">{places.length}</span>
      </button>
      <div className="space-y-1.5">
        {places.map((p) => (
          <div key={p.id} className="plan-list-row">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--ink)]"
              onClick={() => onFocus(p.id)}
            >
              {p.name}
            </button>
            <select
              className="plan-day-select"
              defaultValue=""
              aria-label={`Schedule ${p.name}`}
              onChange={(e) => {
                if (e.target.value) onSchedule(p.id, e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">Day…</option>
              {days.map((d, i) => (
                <option key={d} value={d}>
                  D{i + 1}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="px-1 text-[11px] text-rose-300/90"
              onClick={() => onRemove(p.id)}
            >
              ✕
            </button>
          </div>
        ))}
        {!places.length ? (
          <p className="px-1 py-2 text-[12px] text-[var(--ink-muted)]">
            Empty — save a suggestion or add a place
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Local Plan AI: parse simple intents into places (no network). */
export function applyLocalPlanAi(
  trip: TripRecord,
  prompt: string,
): { trip: TripRecord; message: string } {
  const q = prompt.toLowerCase()
  if (q.includes('provence') || q.includes('france')) {
    const pack = findRegionPack('provence')
    if (pack) {
      let next = trip
      for (const p of pack.places) {
        if (q.includes('food') && p.section !== 'Food') continue
        if (q.includes('must') && p.section !== 'Must see') continue
        let section = next.planSections.find(
          (s) => s.title.toLowerCase() === p.section.toLowerCase(),
        )
        if (!section) {
          section = {
            id: createId('SEC'),
            title: p.section,
            color: '#60a5fa',
            icon: '📍',
            order: next.planSections.length,
          }
          next = { ...next, planSections: [...next.planSections, section] }
        }
        next = addPlanPlace(next, {
          sectionId: section.id,
          name: p.name,
          city: p.city,
          lat: p.lat,
          lon: p.lon,
          notes: p.notes,
        })
      }
      return { trip: next, message: `Added ideas from ${pack.label}.` }
    }
  }
  if (q.includes('tuscany') || q.includes('italy')) {
    const pack = findRegionPack('tuscany')
    if (pack) {
      let next = trip
      for (const p of pack.places) {
        let section = next.planSections.find(
          (s) => s.title.toLowerCase() === p.section.toLowerCase(),
        )
        if (!section) {
          section = {
            id: createId('SEC'),
            title: p.section,
            color: '#34d399',
            icon: '📍',
            order: next.planSections.length,
          }
          next = { ...next, planSections: [...next.planSections, section] }
        }
        next = addPlanPlace(next, {
          sectionId: section.id,
          name: p.name,
          city: p.city,
          lat: p.lat,
          lon: p.lon,
          notes: p.notes,
        })
      }
      return { trip: next, message: `Added ideas from ${pack.label}.` }
    }
  }
  return {
    trip,
    message: 'Try “fill Food for Provence” or “Tuscany starters”.',
  }
}
