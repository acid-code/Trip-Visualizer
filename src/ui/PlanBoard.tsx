import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanPlace, PlanSection, TripRecord } from '../domain/types'
import { listTripDays } from '../data/dayBases'
import {
  addPlanPlace,
  dayTravelLegs,
  JOURNEY_SECTION_TITLE,
  optimizeDayRoute,
  planMaybeSection,
  planSectionForExploreCategory,
  promotePlanPlaceToStep,
  removePlanPlace,
  unschedulePlanPlace,
  upsertPlanPlaceToSection,
} from '../data/planBoard'
import { REGION_PACKS, findRegionPack } from '../data/regionPacks'
import { createId } from '../data/db'
import {
  exploreCategoryEmoji,
  exploreCategoryLabel,
  fetchNearbyExplore,
  filterAndSortExplore,
  type ExploreCategory,
  type ExplorePlace,
} from '../data/explore'
import {
  explorePlaceFromTextHit,
  fetchGoogleTextViaProxy,
} from '../data/placesGoogle'
import {
  extractCoordsFromText,
  locationQueryFromInput,
  lookupPlace,
} from '../data/enrichment'
import { isValidCoord } from '../data/validate'
import { PlanMapView } from '../map/PlanMapView'
import { Chip, IconButton, SegmentedControl } from './primitives'
import { ExplorePlaceDetailSheet } from './ExplorePlaceDetailSheet'
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

const SUGGEST_CATS: Array<{
  id: ExploreCategory | 'all'
  short: string
  emoji: string
  blurb: string
}> = [
  { id: 'all', short: 'All', emoji: '✨', blurb: 'Popular places nearby' },
  { id: 'sights', short: 'Sights', emoji: '🏛️', blurb: 'Museums & landmarks' },
  { id: 'food', short: 'Food', emoji: '🍽️', blurb: 'Restaurants & cafés' },
  { id: 'drink', short: 'Drinks', emoji: '🍷', blurb: 'Bars & wine' },
  { id: 'hotel', short: 'Hotels', emoji: '🛏️', blurb: 'Places to stay' },
  { id: 'nature', short: 'Nature', emoji: '🌿', blurb: 'Parks & outdoors' },
]

function tripMapAnchor(trip: TripRecord): { lat: number; lon: number } {
  const pts: Array<{ lat: number; lon: number }> = []
  for (const p of trip.planPlaces) {
    if (isValidCoord(p.lat, p.lon)) pts.push({ lat: p.lat!, lon: p.lon! })
  }
  // Prefer plan pins; journey items only if the plan has no coords yet.
  if (!pts.length) {
    for (const i of trip.items) {
      if (isValidCoord(i.lat, i.lon)) pts.push({ lat: i.lat!, lon: i.lon! })
      if (isValidCoord(i.latTo, i.lonTo)) pts.push({ lat: i.latTo!, lon: i.lonTo! })
    }
  }
  if (!pts.length) return { lat: 43.7, lon: 5.2 }
  if (pts.length === 1) return pts[0]!
  // Medoid — mean of a multi-city trip often lands in empty countryside.
  let best = pts[0]!
  let bestSum = Infinity
  for (const a of pts) {
    let sum = 0
    for (const b of pts) {
      const dLat = a.lat - b.lat
      const dLon = a.lon - b.lon
      sum += dLat * dLat + dLon * dLon
    }
    if (sum < bestSum) {
      bestSum = sum
      best = a
    }
  }
  return best
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
  const [showNearbyPins, setShowNearbyPins] = useState(true)
  const [suggestCat, setSuggestCat] = useState<ExploreCategory | 'all'>('sights')
  const [suggestions, setSuggestions] = useState<ExplorePlace[]>([])
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [mapView, setMapView] = useState<{
    lat: number
    lon: number
    radiusM: number
  } | null>(null)
  const [daysAll, setDaysAll] = useState(false)
  const [focusPlaceId, setFocusPlaceId] = useState<string | null>(null)
  const [focusSuggestionId, setFocusSuggestionId] = useState<string | null>(null)
  const [detailPlace, setDetailPlace] = useState<ExplorePlace | null>(null)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  /** Recommendation search replaces Nearby with a single loaded place. */
  const [pinnedSearch, setPinnedSearch] = useState<ExplorePlace | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [packsOpen, setPacksOpen] = useState(false)
  const suggestAbortRef = useRef<AbortController | null>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)

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
    if (mode !== 'days') return null
    if (daysAll) return null
    if (!daySafe) return null
    return new Set([daySafe])
  }, [mode, daySafe, daysAll])

  const unscheduled = trip.planPlaces.filter((p) => !p.scheduledDay)
  const bySection = (sectionId: string) =>
    unscheduled.filter((p) => p.sectionId === sectionId)

  const filteredSuggestions = useMemo(() => {
    if (pinnedSearch) return [pinnedSearch]
    return filterAndSortExplore(suggestions, suggestCat, 'rating')
  }, [suggestions, suggestCat, pinnedSearch])

  const suggestionPins = useMemo(
    () =>
      mode === 'discover' && showNearbyPins
        ? filteredSuggestions.map((p) => ({
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            name: p.name,
            emoji: exploreCategoryEmoji(p.category),
          }))
        : [],
    [mode, filteredSuggestions, showNearbyPins],
  )

  useEffect(() => {
    if (!filterMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (filterMenuRef.current?.contains(e.target as Node)) return
      setFilterMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [filterMenuOpen])

  useEffect(() => {
    setFilterMenuOpen(false)
  }, [mode])

  const dayPlaces =
    mode === 'days' && daysAll
      ? trip.planPlaces
          .filter((p) => Boolean(p.scheduledDay))
          .sort((a, b) => {
            const da = a.scheduledDay || ''
            const db = b.scheduledDay || ''
            if (da !== db) return da.localeCompare(db)
            return (a.dayOrder ?? 0) - (b.dayOrder ?? 0)
          })
      : !daySafe
        ? []
        : trip.planPlaces
            .filter((p) => p.scheduledDay === daySafe)
            .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))

  const legs = !daysAll && daySafe ? dayTravelLegs(trip, daySafe) : []
  const dayIdx = daySafe ? days.indexOf(daySafe) : -1
  const totalKm = legs.reduce((s, l) => s + (l?.km ?? 0), 0)
  const totalMin = legs.reduce((s, l) => s + (l?.minutes ?? 0), 0)

  useEffect(() => {
    if (mode !== 'discover') return
    if (pinnedSearch) return
    const fallback = tripMapAnchor(trip)
    const anchor = mapView
      ? { lat: mapView.lat, lon: mapView.lon }
      : fallback
    const radiusM = mapView?.radiusM ?? 12_000
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
          categories: suggestCat === 'all' ? undefined : [suggestCat],
          radiusM,
          limit: placesEnabled ? 20 : 30,
          rankPreference: 'POPULARITY',
          onCacheHit: (cached) => {
            if (!ac.signal.aborted) {
              setSuggestions(cached)
              setSuggestBusy(false)
            }
          },
        })
        if (ac.signal.aborted) return
        setSuggestions(places)
        if (!places.length) setSuggestError('No suggestions in this map view — pan or zoom, or try another type')
        else setSuggestError(null)
      } catch (err) {
        if (ac.signal.aborted) return
        setSuggestError(err instanceof Error ? err.message : 'Could not load suggestions')
      } finally {
        if (!ac.signal.aborted) setSuggestBusy(false)
      }
    })()
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    suggestCat,
    placesEnabled,
    googleApiKey,
    trip.id,
    trip.planPlaces.length,
    trip.items.length,
    mapView?.lat,
    mapView?.lon,
    mapView?.radiusM,
    pinnedSearch,
  ])

  function toggleSectionLayer(id: string) {
    setHiddenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearPinnedSearch() {
    setPinnedSearch(null)
    setSearchQuery('')
    setDetailPlace(null)
    setFocusSuggestionId(null)
  }

  async function searchRecommendation(raw: string) {
    const q = raw.trim()
    if (!q) return
    setSearchBusy(true)
    setSuggestError(null)
    try {
      const anchor = mapView ?? tripMapAnchor(trip)
      const pasted = extractCoordsFromText(q)
      if (pasted) {
        const place: ExplorePlace = {
          id: `search:${pasted.lat.toFixed(5)},${pasted.lon.toFixed(5)}`,
          name: q.length < 80 ? q : 'Pinned location',
          lat: pasted.lat,
          lon: pasted.lon,
          category: 'sights',
          osmType: 'search',
          osmId: '',
          wikidata: '',
          images: [],
          summary: 'Loaded from coordinates — save to Must see or Maybe',
          distKm: 0,
          rating: null,
          cuisine: '',
          website: '',
          menuUrl: '',
          openingHours: '',
          address: `${pasted.lat.toFixed(5)}, ${pasted.lon.toFixed(5)}`,
          tags: { source: 'search' },
        }
        setPinnedSearch(place)
        setShowNearbyPins(true)
        setSuggestCat('all')
        setFocusSuggestionId(place.id)
        setFocusPlaceId(null)
        setDetailPlace(place)
        onStatus?.('Loaded pin — save when ready')
        return
      }

      const query = locationQueryFromInput(q) || (/^https?:\/\//i.test(q) ? '' : q)
      if (!query) {
        setSuggestError('Couldn’t read that link — paste a place name or Maps URL')
        return
      }

      if (placesEnabled) {
        const hit = await fetchGoogleTextViaProxy({
          query,
          apiKey: googleApiKey || undefined,
          bias: { lat: anchor.lat, lon: anchor.lon, radiusM: mapView?.radiusM ?? 80_000 },
        })
        if (hit) {
          const place = explorePlaceFromTextHit(hit, anchor, googleApiKey)
          const typed =
            place.category === 'food' ||
            place.category === 'drink' ||
            place.category === 'hotel' ||
            place.category === 'sights' ||
            place.category === 'nature'
          if (typed) setSuggestCat(place.category)
          else {
            place.category = 'sights'
            setSuggestCat('sights')
          }
          setPinnedSearch(place)
          setShowNearbyPins(true)
          setFocusSuggestionId(place.id)
          setFocusPlaceId(null)
          setDetailPlace(place)
          onStatus?.(
            typed
              ? `Found ${exploreCategoryLabel(place.category).toLowerCase()} — save from Nearby`
              : 'Loaded place — save to Must see when ready',
          )
          return
        }
      }

      const lookup = await lookupPlace(query, {
        useGooglePlaces: placesEnabled,
        googleApiKey: googleApiKey || undefined,
        bias: { lat: anchor.lat, lon: anchor.lon, radiusM: 80_000 },
      })
      if (!lookup) {
        setSuggestError('No place found for that search')
        return
      }
      const place: ExplorePlace = {
        id: lookup.osmId || `search:${lookup.lat.toFixed(5)},${lookup.lon.toFixed(5)}`,
        name: lookup.name || query,
        lat: lookup.lat,
        lon: lookup.lon,
        category: 'sights',
        osmType: lookup.osmId.startsWith('google:') ? 'google' : 'search',
        osmId: lookup.osmId,
        wikidata: '',
        images: [],
        summary: 'Recommendation loaded — save to Must see or Maybe',
        distKm: 0,
        rating: null,
        cuisine: '',
        website: '',
        menuUrl: '',
        openingHours: '',
        address: lookup.address || '',
        tags: {
          source: lookup.osmId.startsWith('google:') ? 'google' : 'search',
        },
      }
      setPinnedSearch(place)
      setSuggestCat('sights')
      setShowNearbyPins(true)
      setFocusSuggestionId(place.id)
      setFocusPlaceId(null)
      setDetailPlace(place)
      onStatus?.('Loaded place — save to Must see when ready')
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearchBusy(false)
    }
  }

  function saveSuggestion(place: ExplorePlace, toMaybe = false) {
    const section = toMaybe
      ? planMaybeSection(trip)
      : planSectionForExploreCategory(trip, place.category)
    if (!section) {
      onStatus?.(toMaybe ? 'No Maybe list found' : 'No matching list for this type')
      return
    }
    const result = upsertPlanPlaceToSection(trip, {
      sectionId: section.id,
      name: place.name,
      place: place.address || place.name,
      city: '',
      lat: place.lat,
      lon: place.lon,
      notes: place.summary || place.cuisine || '',
      googleMapsUri: place.tags.googleMapsUri || '',
      osmId: place.id.startsWith('osm:') ? place.id : '',
    })
    onChange(result.trip)
    setFocusSuggestionId(null)
    setDetailPlace(null)
    if (pinnedSearch && pinnedSearch.id === place.id) {
      setPinnedSearch(null)
      setSearchQuery('')
    }
    if (!result.created && !result.moved) {
      onStatus?.(`“${place.name}” is already in ${result.sectionTitle}`)
    } else if (result.moved) {
      onStatus?.(`Moved “${place.name}” to ${result.sectionTitle}`)
    } else {
      onStatus?.(`Saved “${place.name}” to ${result.sectionTitle}`)
    }
  }

  function schedulePlace(placeId: string, day: string) {
    onChange(promotePlanPlaceToStep(trip, placeId, day))
    setMode('days')
    setDaysAll(false)
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

  const activeCatMeta =
    SUGGEST_CATS.find((c) => c.id === suggestCat) ?? SUGGEST_CATS[1]!
  const activeDayIdx = daySafe ? Math.max(0, days.indexOf(daySafe)) : 0

  function openSuggestionDetail(place: ExplorePlace) {
    setFocusSuggestionId(place.id)
    setFocusPlaceId(null)
    setDetailPlace(place)
  }

  function saveLabelFor(place: ExplorePlace): string {
    const section = planSectionForExploreCategory(trip, place.category)
    return section ? `Save to ${section.title}` : 'Save'
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
          <div ref={filterMenuRef} className="relative w-fit">
            <button
              type="button"
              className="plan-filter-trigger"
              aria-expanded={filterMenuOpen}
              aria-haspopup="listbox"
              onClick={() => setFilterMenuOpen((v) => !v)}
            >
              {mode === 'discover' ? (
                <>
                  <span className="text-base leading-none" aria-hidden>
                    {activeCatMeta.emoji}
                  </span>
                  <span className="font-semibold">{activeCatMeta.short}</span>
                </>
              ) : daysAll ? (
                <>
                  <span className="text-base leading-none" aria-hidden>
                    🗓️
                  </span>
                  <span className="font-semibold">All days</span>
                </>
              ) : (
                <>
                  <span className="text-base leading-none" aria-hidden>
                    📅
                  </span>
                  <span className="font-semibold">Day {activeDayIdx + 1}</span>
                </>
              )}
              <svg
                className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition ${filterMenuOpen ? 'rotate-180' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {filterMenuOpen ? (
              <div className="plan-filter-menu" role="listbox">
                {mode === 'discover'
                  ? SUGGEST_CATS.map((c) => {
                      const on = c.id === suggestCat
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="option"
                          aria-selected={on}
                          className={`plan-filter-option ${on ? 'plan-filter-option-on' : ''}`}
                          onClick={() => {
                            setPinnedSearch(null)
                            setSuggestCat(c.id)
                            setFilterMenuOpen(false)
                          }}
                        >
                          <span className="plan-filter-option-emoji" aria-hidden>
                            {c.emoji}
                          </span>
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block text-sm font-semibold text-[var(--ink)]">
                              {c.short}
                            </span>
                            <span className="block text-[11px] text-[var(--ink-muted)]">
                              {c.blurb}
                            </span>
                          </span>
                        </button>
                      )
                    })
                  : (
                    <>
                      <button
                        type="button"
                        role="option"
                        aria-selected={daysAll}
                        className={`plan-filter-option ${daysAll ? 'plan-filter-option-on' : ''}`}
                        onClick={() => {
                          setDaysAll(true)
                          setFilterMenuOpen(false)
                        }}
                      >
                        <span className="plan-filter-option-emoji" aria-hidden>
                          🗓️
                        </span>
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block text-sm font-semibold text-[var(--ink)]">
                            All days
                          </span>
                          <span className="block text-[11px] text-[var(--ink-muted)]">
                            Whole trip on the map
                          </span>
                        </span>
                      </button>
                      {days.map((day, idx) => {
                        const on = !daysAll && day === daySafe
                        return (
                          <button
                            key={day}
                            type="button"
                            role="option"
                            aria-selected={on}
                            className={`plan-filter-option ${on ? 'plan-filter-option-on' : ''}`}
                            onClick={() => {
                              setDaysAll(false)
                              setActiveDay(day)
                              setFilterMenuOpen(false)
                            }}
                          >
                            <span className="plan-filter-option-emoji tabular-nums" aria-hidden>
                              {idx + 1}
                            </span>
                            <span className="min-w-0 flex-1 text-left">
                              <span className="block text-sm font-semibold text-[var(--ink)]">
                                Day {idx + 1}
                              </span>
                              <span className="block text-[11px] text-[var(--ink-muted)]">
                                {day}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </>
                  )}
              </div>
            ) : null}
          </div>
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
            setDetailPlace(null)
          }}
          onSuggestionClick={(id) => {
            const place = filteredSuggestions.find((p) => p.id === id)
            if (place) openSuggestionDetail(place)
          }}
          onViewportIdle={(view) => {
            setMapView((prev) => {
              if (
                prev &&
                Math.abs(prev.lat - view.lat) < 0.0015 &&
                Math.abs(prev.lon - view.lon) < 0.0015 &&
                Math.abs(prev.radiusM - view.radiusM) < Math.max(200, view.radiusM * 0.08)
              ) {
                return prev
              }
              return view
            })
          }}
          className="h-full"
        />
      </div>

      {detailPlace ? (
        <ExplorePlaceDetailSheet
          place={detailPlace}
          onClose={() => setDetailPlace(null)}
          primaryLabel={saveLabelFor(detailPlace)}
          onPrimary={() => saveSuggestion(detailPlace, false)}
          secondaryLabel="Maybe"
          onSecondary={() => saveSuggestion(detailPlace, true)}
        />
      ) : null}

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
                    {pinnedSearch ? 'Recommendation' : `Nearby ${suggestCat === 'all' ? 'all' : exploreCategoryLabel(suggestCat)}`}
                    {suggestBusy || searchBusy ? ' · …' : ''}
                  </p>
                  <span className="flex items-center gap-2 text-[10px] tabular-nums text-[var(--ink-muted)]">
                    {pinnedSearch ? (
                      <button
                        type="button"
                        className="font-semibold text-[var(--coral)]"
                        onClick={clearPinnedSearch}
                      >
                        Clear
                      </button>
                    ) : null}
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
                        onClick={() => openSuggestionDetail(p)}
                      >
                        <span className="mb-1 block text-base leading-none" aria-hidden>
                          {exploreCategoryEmoji(p.category)}
                        </span>
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
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          className="rounded-full bg-[var(--coral)] px-2.5 py-0.5 text-[10px] font-semibold text-white"
                          onClick={() => saveSuggestion(p, false)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--paper-2)] text-sm"
                          title="Save to Maybe"
                          aria-label={`Save ${p.name} to Maybe`}
                          onClick={() => saveSuggestion(p, true)}
                        >
                          💭
                        </button>
                      </div>
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
                <Chip
                  on={showNearbyPins}
                  onClick={() => setShowNearbyPins((v) => !v)}
                  title="Show Nearby suggestions on the map"
                >
                  ✨ Nearby
                </Chip>
                {listSections.map((section) => (
                  <Chip
                    key={section.id}
                    on={!hiddenSections.has(section.id)}
                    onClick={() => toggleSectionLayer(section.id)}
                    title={`Show ${section.title} on map`}
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
                  Find a recommendation
                </div>
                <p className="mb-2 text-[11px] text-[var(--ink-muted)]">
                  Paste a name, address, or Maps link — we’ll load it into Nearby so you can save it.
                </p>
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void searchRecommendation(searchQuery)
                  }}
                >
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Place name or Maps link…"
                    className="plan-input"
                    disabled={searchBusy}
                  />
                  <IconButton type="submit" disabled={searchBusy || !searchQuery.trim()}>
                    {searchBusy ? '…' : 'Go'}
                  </IconButton>
                </form>
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
                    {daysAll ? 'All days' : `Day ${dayIdx + 1}`}
                  </h2>
                  <p className="text-[12px] text-[var(--ink-muted)]">
                    {daysAll ? `${days.length} days` : daySafe}
                    {dayPlaces.length
                      ? ` · ${dayPlaces.length} stop${dayPlaces.length === 1 ? '' : 's'}`
                      : ''}
                    {!daysAll && totalKm > 0
                      ? ` · ${totalKm.toFixed(0)} km · ~${totalMin} min`
                      : ''}
                  </p>
                </div>
                <IconButton
                  title="Optimize route"
                  disabled={daysAll || dayPlaces.length < 2}
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
                        <span className="plan-stop-num">
                          {daysAll
                            ? Math.max(1, days.indexOf(p.scheduledDay || '') + 1)
                            : i + 1}
                        </span>
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate text-[15px] font-medium text-[var(--ink)]">
                            {p.name}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--ink-muted)]">
                            {daysAll && p.scheduledDay
                              ? `Day ${Math.max(1, days.indexOf(p.scheduledDay) + 1)}`
                              : p.city || ''}
                          </span>
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
                    {!daysAll && legs[i] ? (
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

              {!daysAll && daySafe && unscheduled.length > 0 ? (
                <div className="mt-3 border-t border-[var(--glass-border)] pt-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                    Add from saved
                  </p>
                  <div className={`max-h-48 space-y-1.5 overflow-y-auto ${TOUCH_SCROLL_Y}`}>
                    {unscheduled.map((p) => {
                      const section = trip.planSections.find((s) => s.id === p.sectionId)
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className="plan-add-stop-card"
                          onClick={() => schedulePlace(p.id, daySafe)}
                        >
                          <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                            style={{
                              background: `${section?.color || '#60a5fa'}33`,
                            }}
                            aria-hidden
                          >
                            {section?.icon || '📍'}
                          </span>
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-[13px] font-semibold text-[var(--ink)]">
                              {p.name}
                            </span>
                            <span className="block truncate text-[10px] text-[var(--ink-muted)]">
                              {section?.title || 'List'}
                              {p.city ? ` · ${p.city}` : ''}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full bg-[var(--coral)] px-2.5 py-1 text-[10px] font-semibold text-white">
                            Add
                          </span>
                        </button>
                      )
                    })}
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
          <div key={p.id} className="plan-list-row plan-list-row-stack">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--ink)]"
                onClick={() => onFocus(p.id)}
              >
                {p.name}
              </button>
              <button
                type="button"
                className="shrink-0 px-1 text-[11px] text-rose-300/90"
                onClick={() => onRemove(p.id)}
              >
                ✕
              </button>
            </div>
            <div className={`flex gap-1 ${TOUCH_SCROLL_X}`}>
              {days.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  className="plan-day-mini shrink-0"
                  onClick={() => onSchedule(p.id, d)}
                >
                  Day {i + 1}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!places.length ? (
          <p className="px-1 py-2 text-[12px] text-[var(--ink-muted)]">
            Empty — save a suggestion or find a recommendation
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
