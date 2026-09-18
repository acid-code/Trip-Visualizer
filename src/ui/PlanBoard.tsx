import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { PlanPlace, PlanSection, TripRecord } from '../domain/types'
import { listTripDays, weekdayShort } from '../data/dayBases'
import {
  addPlanPlace,
  applyExploreEnrichmentToPlanPlace,
  JOURNEY_SECTION_TITLE,
  optimizeDayRoute,
  planMaybeSection,
  planPlaceNeedsEnrichment,
  planSectionForExploreCategory,
  promotePlanPlaceToStep,
  removePlanPlace,
  reorderDayPlaces,
  unschedulePlanPlace,
  upsertPlanPlaceToSection,
} from '../data/planBoard'
import { findRegionPack } from '../data/regionPacks'
import { createId, nowIso } from '../data/db'
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
  googlePlacePhotoMediaUrl,
} from '../data/placesGoogle'
import {
  extractCoordsFromText,
  locationQueryFromInput,
  lookupPlace,
} from '../data/enrichment'
import { isValidCoord } from '../data/validate'
import { distKm } from '../data/routes'
import { PlanMapView } from '../map/PlanMapView'
import { IconButton, SegmentedControl } from './primitives'
import { ExplorePlaceDetailSheet } from './ExplorePlaceDetailSheet'
import { PlanMapLayersControl } from './PlanMapLayersControl'
import { MapSearchBar } from './MapSearchBar'
import { AiSparkIcon } from './AiCoachSheet'
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
  /** Shared with Journey Steps — null means all days. */
  dayFilter?: string | null
  onDayFilter?: (day: string | null) => void
  /** Keep Plan map camera aligned with Journey. */
  initialMapFocus?: import('../data/mapFocus').MapFocus | null
  mapFocusApiRef?: MutableRefObject<
    import('../data/mapFocus').MapFocusApi | null
  >
  /** Fired once when Plan MapLibre has loaded (boot splash). */
  onMapBootReady?: () => void
  /**
   * When a Plan place assigned to a day is focused, sync that Journey step
   * highlight (quiet — does not open Journey sheets).
   */
  onJourneyHighlight?: (itemId: string | null) => void
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
  { id: 'activity', short: 'Do', emoji: '🎟️', blurb: 'Fun & tickets' },
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
  dayFilter = null,
  onDayFilter,
  initialMapFocus = null,
  mapFocusApiRef,
  onMapBootReady,
  onJourneyHighlight,
}: Props) {
  const days = listTripDays(trip.meta)
  const [mode, setMode] = useState<PlanMode>('discover')
  const daysAll = dayFilter == null
  const activeDay =
    dayFilter && days.includes(dayFilter) ? dayFilter : (days[0] ?? '')
  const setDaysAll = (all: boolean) => {
    if (all) onDayFilter?.(null)
    else if (activeDay) onDayFilter?.(activeDay)
  }
  const setActiveDay = (day: string) => {
    onDayFilter?.(day)
  }
  const [activeSectionId, setActiveSectionId] = useState(
    trip.planSections.find((s) => s.title !== JOURNEY_SECTION_TITLE)?.id ??
      trip.planSections[0]?.id ??
      '',
  )
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(new Set())
  const [showNearbyPins, setShowNearbyPins] = useState(false)
  const [suggestCat, setSuggestCat] = useState<ExploreCategory | 'all'>('sights')
  const [suggestions, setSuggestions] = useState<ExplorePlace[]>([])
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [mapView, setMapView] = useState<{
    lat: number
    lon: number
    radiusM: number
  } | null>(null)
  const [focusPlaceId, setFocusPlaceId] = useState<string | null>(null)
  const [focusSuggestionId, setFocusSuggestionId] = useState<string | null>(null)
  const [detailPlace, setDetailPlace] = useState<ExplorePlace | null>(null)
  /** When set, detail sheet is a saved Plan place (not a Nearby suggestion). */
  const [detailSavedId, setDetailSavedId] = useState<string | null>(null)
  const [filterMenu, setFilterMenu] = useState<'type' | 'day' | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  /** Recommendation search replaces Nearby with a single loaded place. */
  const [pinnedSearch, setPinnedSearch] = useState<ExplorePlace | null>(null)
  const [selectedUnscheduledId, setSelectedUnscheduledId] = useState<string | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [showJourneyPins, setShowJourneyPins] = useState(true)
  const suggestAbortRef = useRef<AbortController | null>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)
  const discoverListRef = useRef<HTMLDivElement>(null)
  /** Nearby layer preference while in Discover — restored when leaving Days. */
  const discoverNearbyPrefRef = useRef(false)
  const tripRef = useRef(trip)
  tripRef.current = trip
  /** Place ids we've already tried to backfill this session. */
  const enrichAttemptedRef = useRef(new Set<string>())
  const enrichInFlightRef = useRef(new Set<string>())
  const detailSavedIdRef = useRef<string | null>(null)
  detailSavedIdRef.current = detailSavedId

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

  const journeySection = useMemo(
    () =>
      trip.planSections.find(
        (s) =>
          s.title === JOURNEY_SECTION_TITLE ||
          s.title.toLowerCase() === 'journey' ||
          s.title.toLowerCase() === 'on the trip',
      ) ?? null,
    [trip.planSections],
  )

  const visibleSectionIds = useMemo(() => {
    const ids = new Set(trip.planSections.map((s) => s.id))
    for (const id of hiddenSections) ids.delete(id)
    // Days: Journey pins always stay on. Discover: respect the Journey layer toggle.
    if (mode === 'discover' && journeySection && !showJourneyPins) {
      ids.delete(journeySection.id)
    }
    return ids
  }, [trip.planSections, hiddenSections, journeySection, showJourneyPins, mode])

  const mapVisibleDays = useMemo(() => {
    if (daysAll) return null
    if (!daySafe) return null
    return new Set([daySafe])
  }, [daySafe, daysAll])

  const unscheduled = trip.planPlaces.filter((p) => !p.scheduledDay)
  const bySectionUnscheduled = (sectionId: string) =>
    unscheduled.filter((p) => p.sectionId === sectionId)
  const bySectionAll = (sectionId: string) =>
    trip.planPlaces.filter((p) => p.sectionId === sectionId)

  const linkedItemTypes = useMemo(() => {
    const map: Record<string, (typeof trip.items)[number]['type']> = {}
    for (const item of trip.items) map[item.id] = item.type
    return map
  }, [trip.items])

  const filteredSuggestions = useMemo(() => {
    if (pinnedSearch) return [pinnedSearch]
    return filterAndSortExplore(suggestions, suggestCat, 'rating')
  }, [suggestions, suggestCat, pinnedSearch])

  const suggestionPins = useMemo(
    () =>
      showNearbyPins
        ? filteredSuggestions.map((p) => ({
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            name: p.name,
            emoji: exploreCategoryEmoji(p.category),
          }))
        : [],
    [filteredSuggestions, showNearbyPins],
  )

  useEffect(() => {
    if (!filterMenu) return
    const onDoc = (e: MouseEvent) => {
      if (filterMenuRef.current?.contains(e.target as Node)) return
      setFilterMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [filterMenu])

  useEffect(() => {
    setFilterMenu(null)
    setSelectedUnscheduledId(null)
    if (mode === 'days') {
      discoverNearbyPrefRef.current = showNearbyPins
      setShowNearbyPins(false)
      setShowJourneyPins(true)
      setFocusSuggestionId(null)
      return
    }
    // Back to Discover — restore Nearby if it was on before Days.
    setShowNearbyPins(discoverNearbyPrefRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to mode flips; capture Nearby at enter-Days time
  }, [mode])

  useEffect(() => {
    if (mode !== 'discover') return
    discoverNearbyPrefRef.current = showNearbyPins
  }, [mode, showNearbyPins])

  useEffect(() => {
    if (mode !== 'days') return
    if (detailSavedId) return
    setDetailPlace(null)
  }, [mode, detailSavedId])

  function placesForDay(day: string) {
    return trip.planPlaces
      .filter((p) => p.scheduledDay === day)
      .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
  }

  useEffect(() => {
    if (mode !== 'discover') return
    if (!showNearbyPins) {
      suggestAbortRef.current?.abort()
      setSuggestBusy(false)
      return
    }
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
    showNearbyPins,
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

  function toggleNearbyLayer() {
    setShowNearbyPins((on) => {
      if (on) {
        suggestAbortRef.current?.abort()
        setSuggestions([])
        setSuggestBusy(false)
        setSuggestError(null)
        setFocusSuggestionId(null)
        setDetailPlace(null)
        setDetailSavedId(null)
        setPinnedSearch(null)
        setPinnedSearch(null)
      }
      return !on
    })
  }

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
    setDetailPlace(null)
    setDetailSavedId(null)
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
        setSuggestCat('all')
        setFocusSuggestionId(place.id)
        setFocusPlaceId(null)
        setDetailSavedId(null)
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
            place.category === 'activity' ||
            place.category === 'nature'
          if (typed) setSuggestCat(place.category)
          else {
            place.category = 'sights'
            setSuggestCat('sights')
          }
          setPinnedSearch(place)
          setFocusSuggestionId(place.id)
          setFocusPlaceId(null)
          setDetailSavedId(null)
          setDetailPlace(place)
          onStatus?.(
            typed
              ? `Found ${exploreCategoryLabel(place.category).toLowerCase()} — save when ready`
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
      setFocusSuggestionId(place.id)
      setFocusPlaceId(null)
      setDetailSavedId(null)
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
      notes: '',
      url: place.website || '',
      googleMapsUri: place.tags.googleMapsUri || '',
      osmId: place.id.startsWith('osm:') || place.id.startsWith('google:')
        ? place.id
        : place.osmId || '',
      enrichmentSummary: place.summary || '',
      enrichmentImage: place.images[0] || '',
      images: place.images.slice(0, 6),
      openingHours: place.openingHours || '',
      openingPeriods: place.openingPeriods || [],
      rating: place.rating,
      cuisine: place.cuisine || '',
      googlePhotoName: place.tags.googlePhotoName || '',
    })
    onChange(result.trip)
    setFocusSuggestionId(null)
    setDetailPlace(null)
    setDetailSavedId(null)
    if (pinnedSearch && pinnedSearch.id === place.id) {
      setPinnedSearch(null)
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
    setSelectedUnscheduledId(null)
    setActiveDay(day)
    const idx = days.indexOf(day)
    onStatus?.(
      `Added to Day ${idx >= 0 ? idx + 1 : day.slice(5)} · synced to Journey`,
    )
  }

  function moveWithinDay(day: string, placeId: string, dir: -1 | 1) {
    const ordered = trip.planPlaces
      .filter((p) => p.scheduledDay === day)
      .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
    const idx = ordered.findIndex((p) => p.id === placeId)
    if (idx < 0) return
    const j = idx + dir
    if (j < 0 || j >= ordered.length) return
    const ids = ordered.map((p) => p.id)
    ;[ids[idx], ids[j]] = [ids[j]!, ids[idx]!]
    onChange(reorderDayPlaces(trip, day, ids))
    setFocusPlaceId(placeId)
  }

  const activeCatMeta =
    SUGGEST_CATS.find((c) => c.id === suggestCat) ?? SUGGEST_CATS[1]!
  const activeDayIdx = daySafe ? Math.max(0, days.indexOf(daySafe)) : 0

  function journeyItemIdForPlace(p: PlanPlace): string | null {
    if (!p.scheduledDay && !p.linkedItemId) return null
    if (p.linkedItemId && trip.items.some((i) => i.id === p.linkedItemId)) {
      return p.linkedItemId
    }
    if (!p.scheduledDay) return null
    const name = p.name.trim().toLowerCase()
    const match = trip.items.find(
      (i) =>
        i.date === p.scheduledDay &&
        (i.title.trim().toLowerCase() === name ||
          (i.place && i.place.trim().toLowerCase() === name)),
    )
    return match?.id ?? null
  }

  function openSuggestionDetail(place: ExplorePlace) {
    const existing = findMatchingListPlace(trip, place)
    if (existing) {
      openSavedPlaceDetail(existing.id)
      setFocusSuggestionId(place.id)
      return
    }
    setFocusSuggestionId(place.id)
    setFocusPlaceId(null)
    setDetailSavedId(null)
    setDetailPlace(place)
    onJourneyHighlight?.(null)
  }

  function openSavedPlaceDetail(placeId: string) {
    const p = trip.planPlaces.find((x) => x.id === placeId)
    if (!p) return
    const section = trip.planSections.find((s) => s.id === p.sectionId)
    const anchor = mapView
      ? { lat: mapView.lat, lon: mapView.lon }
      : tripMapAnchor(trip)
    setFocusPlaceId(isValidCoord(p.lat, p.lon) ? placeId : null)
    setFocusSuggestionId(null)
    setActiveSectionId(p.sectionId)
    setDetailSavedId(p.id)
    setDetailPlace(planPlaceToExplorePlace(p, section, days, anchor))
    onJourneyHighlight?.(journeyItemIdForPlace(p))
    if (planPlaceNeedsEnrichment(p)) {
      void refillPlanPlaceEnrichment(placeId)
    }
  }

  async function refillPlanPlaceEnrichment(placeId: string) {
    if (!placesEnabled && !googleApiKey) return
    if (enrichInFlightRef.current.has(placeId)) return
    const current = tripRef.current.planPlaces.find((p) => p.id === placeId)
    if (!current || !planPlaceNeedsEnrichment(current)) return
    enrichInFlightRef.current.add(placeId)
    enrichAttemptedRef.current.add(placeId)
    try {
      const query = [current.name, current.place, current.city]
        .filter(Boolean)
        .join(', ')
        .trim()
      if (!query) return
      const bias =
        isValidCoord(current.lat, current.lon)
          ? { lat: current.lat!, lon: current.lon!, radiusM: 8_000 }
          : mapView
            ? { lat: mapView.lat, lon: mapView.lon, radiusM: 50_000 }
            : tripMapAnchor(tripRef.current)
      const hit = await fetchGoogleTextViaProxy({
        query,
        apiKey: googleApiKey || undefined,
        bias,
      })
      if (!hit) return
      const explored = explorePlaceFromTextHit(
        hit,
        { lat: hit.lat, lon: hit.lon },
        googleApiKey,
      )
      // Prefer Google reviews blurb when summary is empty.
      if (!explored.summary && hit.userRatingCount) {
        explored.summary = `${hit.userRatingCount} Google reviews`
      }
      const latest = tripRef.current
      const before = latest.planPlaces.find((p) => p.id === placeId)
      if (!before || !planPlaceNeedsEnrichment(before)) return
      const enriched = applyExploreEnrichmentToPlanPlace(before, explored)
      onChange({
        ...latest,
        planPlaces: latest.planPlaces.map((p) =>
          p.id === placeId ? enriched : p,
        ),
        updatedAt: nowIso(),
      })
      // Refresh open detail if still viewing this place.
      if (detailSavedIdRef.current === placeId) {
        const section = latest.planSections.find((s) => s.id === enriched.sectionId)
        const anchor = mapView
          ? { lat: mapView.lat, lon: mapView.lon }
          : tripMapAnchor(latest)
        setDetailPlace(planPlaceToExplorePlace(enriched, section, days, anchor))
      }
    } catch {
      /* keep thin snapshot; user can reopen later */
    } finally {
      enrichInFlightRef.current.delete(placeId)
    }
  }

  function closePlaceDetail() {
    setDetailPlace(null)
    setDetailSavedId(null)
  }

  useEffect(() => {
    if (!focusPlaceId || mode !== 'discover') return
    const root = discoverListRef.current
    if (!root) return
    const el = root.querySelector(
      `[data-plan-place-id="${CSS.escape(focusPlaceId)}"]`,
    ) as HTMLElement | null
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [focusPlaceId, mode])

  // Quietly backfill photo / hours / summary for places saved before enrichment existed.
  useEffect(() => {
    if (!placesEnabled && !googleApiKey) return
    enrichAttemptedRef.current = new Set()
    let cancelled = false
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    void (async () => {
      await sleep(600)
      const pending = tripRef.current.planPlaces.filter(
        (p) => planPlaceNeedsEnrichment(p) && !enrichAttemptedRef.current.has(p.id),
      )
      for (const p of pending) {
        if (cancelled) break
        await refillPlanPlaceEnrichment(p.id)
        await sleep(450)
      }
    })()
    return () => {
      cancelled = true
    }
    // Only re-run when trip identity or Places availability changes — not every place edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, placesEnabled, googleApiKey])

  function saveLabelFor(place: ExplorePlace): string {
    const section = planSectionForExploreCategory(trip, place.category)
    return section ? `Save to ${section.title}` : 'Save'
  }

  function moveSavedToMaybe(placeId: string) {
    const maybe = planMaybeSection(trip)
    if (!maybe) {
      onStatus?.('No Maybe list found')
      return
    }
    onChange({
      ...trip,
      planPlaces: trip.planPlaces.map((p) =>
        p.id === placeId ? { ...p, sectionId: maybe.id } : p,
      ),
      updatedAt: nowIso(),
    })
    onStatus?.(`Moved to ${maybe.title}`)
  }

  const detailSavedPlace = detailSavedId
    ? trip.planPlaces.find((p) => p.id === detailSavedId) ?? null
    : null
  const focusPlace = focusPlaceId
    ? trip.planPlaces.find((p) => p.id === focusPlaceId) ?? null
    : null
  const focusLinkedItemId = focusPlace ? journeyItemIdForPlace(focusPlace) : null
  const detailSheetPlace =
    detailSavedPlace && detailPlace
      ? planPlaceToExplorePlace(
          detailSavedPlace,
          trip.planSections.find((s) => s.id === detailSavedPlace.sectionId),
          days,
          mapView
            ? { lat: mapView.lat, lon: mapView.lon }
            : tripMapAnchor(trip),
        )
      : detailPlace

  return (
    <div className="plan-phone relative flex h-full min-h-0 flex-col">
      {/* Full-bleed map under Discover/Days — fills corner wedges, stays below the sheet */}
      <div className="absolute inset-0 z-0" data-coach="plan-map">
        <PlanMapView
          meta={trip.meta}
          sections={trip.planSections}
          places={trip.planPlaces}
          visibleSectionIds={visibleSectionIds}
          visibleDays={mapVisibleDays}
          colorBy={mode === 'days' ? 'day' : 'section'}
          hideScheduled={false}
          suggestions={suggestionPins}
          focusPlaceId={focusPlaceId}
          focusLinkedItemId={focusLinkedItemId}
          focusSuggestionId={focusSuggestionId}
          linkedItemTypes={linkedItemTypes}
          initialFocus={initialMapFocus}
          mapFocusApiRef={mapFocusApiRef}
          onBootReady={onMapBootReady}
          onPlaceClick={(id) => {
            openSavedPlaceDetail(id)
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

      {/* Map chrome band — layout space above the sheet; taps pass through to the map */}
      <div className="plan-map-band pointer-events-none relative z-10 min-w-0 flex-1">
        {/* Layers FAB — mirrors Journey map layers, under Journey|Plan */}
        <div
          className="pointer-events-auto absolute right-3 top-[max(4.35rem,calc(var(--phone-chrome-top)+3.6rem))] z-20"
          data-coach="plan-layers"
        >
          <PlanMapLayersControl
            sections={listSections}
            journeySection={journeySection}
            showNearby={showNearbyPins}
            showJourney={showJourneyPins}
            hideNearbyToggle={mode === 'days'}
            hideJourneyToggle={mode === 'days'}
            hiddenSectionIds={hiddenSections}
            onToggleNearby={toggleNearbyLayer}
            onToggleJourney={() => setShowJourneyPins((v) => !v)}
            onToggleSection={toggleSectionLayer}
            panelPlacement="below"
          />
        </div>

        {/* Search — bottom-left, tucked against Discover/Days sheet */}
        <div className="pointer-events-auto absolute bottom-[0.35rem] left-3 z-20">
          <MapSearchBar
            portal={false}
            busy={searchBusy}
            onSearch={(q) => void searchRecommendation(q)}
            onClear={clearPinnedSearch}
            hint={pinnedSearch ? pinnedSearch.name : undefined}
            hintTone={pinnedSearch ? 'pin' : 'quiet'}
          />
        </div>

        {/* Top chrome — left side only so Journey/Plan switcher stays clear */}
        <div className="plan-phone-top phone-chrome-top pointer-events-none absolute inset-x-0 top-0 z-20 px-3">
          <div className="pointer-events-auto flex max-w-[calc(100%-9.5rem)] flex-col gap-2">
            <div data-coach="plan-mode-tabs">
              <SegmentedControl
                ariaLabel="Plan mode"
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'discover', label: 'Discover' },
                  { id: 'days', label: 'Days' },
                ]}
              />
            </div>
            <div ref={filterMenuRef} className="flex flex-wrap items-start gap-1.5">
              {mode === 'discover' ? (
                <div className="relative w-fit">
                  <button
                    type="button"
                    className="plan-filter-trigger"
                    aria-expanded={filterMenu === 'type'}
                    aria-haspopup="listbox"
                    onClick={() =>
                      setFilterMenu((m) => (m === 'type' ? null : 'type'))
                    }
                  >
                    <span className="text-base leading-none" aria-hidden>
                      {activeCatMeta.emoji}
                    </span>
                    <span className="font-semibold">{activeCatMeta.short}</span>
                    <svg
                      className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition ${filterMenu === 'type' ? 'rotate-180' : ''}`}
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
                  {filterMenu === 'type' ? (
                    <div className="plan-filter-menu" role="listbox">
                      {SUGGEST_CATS.map((c) => {
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
                              setFocusSuggestionId(null)
                              setSuggestCat(c.id)
                              setFilterMenu(null)
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
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="relative w-fit">
                <button
                  type="button"
                  className="plan-filter-trigger"
                  aria-expanded={filterMenu === 'day'}
                  aria-haspopup="listbox"
                  onClick={() =>
                    setFilterMenu((m) => (m === 'day' ? null : 'day'))
                  }
                >
                  {daysAll ? (
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
                      <span className="font-semibold">
                        Day {activeDayIdx + 1}
                      </span>
                    </>
                  )}
                  <svg
                    className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition ${filterMenu === 'day' ? 'rotate-180' : ''}`}
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
                {filterMenu === 'day' ? (
                  <div className="plan-filter-menu" role="listbox">
                    <button
                      type="button"
                      role="option"
                      aria-selected={daysAll}
                      className={`plan-filter-option ${daysAll ? 'plan-filter-option-on' : ''}`}
                      onClick={() => {
                        setDaysAll(true)
                        setFilterMenu(null)
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
                            setFilterMenu(null)
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
                              {weekdayShort(day)} · {day.slice(5)}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {detailSheetPlace ? (
        <ExplorePlaceDetailSheet
          place={detailSheetPlace}
          onClose={closePlaceDetail}
          primaryTone={detailSavedId ? 'danger' : 'coral'}
          primaryLabel={detailSavedId ? 'Remove' : saveLabelFor(detailSheetPlace)}
          onPrimary={() => {
            if (detailSavedId) {
              onChange(removePlanPlace(trip, detailSavedId))
              onStatus?.('Removed from list')
              closePlaceDetail()
              return
            }
            saveSuggestion(detailSheetPlace, false)
          }}
          secondaryLabel="Maybe"
          onSecondary={() => {
            if (detailSavedId) {
              moveSavedToMaybe(detailSavedId)
              closePlaceDetail()
              return
            }
            saveSuggestion(detailSheetPlace, true)
          }}
          days={detailSavedId ? days : undefined}
          scheduledDay={detailSavedPlace?.scheduledDay || null}
          onPickDay={
            detailSavedId
              ? (day) => {
                  schedulePlace(detailSavedId, day)
                }
              : undefined
          }
          onClearDay={
            detailSavedId
              ? () => {
                  onChange(unschedulePlanPlace(trip, detailSavedId))
                  onStatus?.('Removed from day · still in list')
                }
              : undefined
          }
          highlightDayISO={dayFilter}
        />
      ) : null}

      {/* Discover / Days sheet — above the full-bleed map; corners show map wedges */}
      <div
        className="plan-sheet-band relative z-20 flex flex-col"
        data-coach="plan-sheet"
      >
        <div
          className={`plan-itin-sheet pointer-events-auto mx-0 flex min-h-0 flex-1 flex-col overflow-hidden ${TOUCH_SCROLL_Y}`}
        >
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--ink-muted)]/35" />

          {mode === 'discover' ? (
            <div
              ref={discoverListRef}
              className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
            >
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                  Discover
                </h2>
                <p className="text-[12px] text-[var(--ink-muted)]">
                  Save map ideas to lists, then schedule them on Days.
                </p>
              </div>

              {showNearbyPins || pinnedSearch ? (
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
              ) : null}

              {listSections.map((section) => (
                <ListSection
                  key={section.id}
                  section={section}
                  places={bySectionAll(section.id)}
                  active={
                    activeSectionId === section.id ||
                    bySectionAll(section.id).some((p) => p.id === focusPlaceId)
                  }
                  focusPlaceId={focusPlaceId}
                  hidden={hiddenSections.has(section.id)}
                  days={days}
                  onSelect={() => setActiveSectionId(section.id)}
                  onFocus={(id) => {
                    openSavedPlaceDetail(id)
                  }}
                  onSchedule={schedulePlace}
                  onUnschedule={(placeId) => {
                    onChange(unschedulePlanPlace(trip, placeId))
                    onStatus?.('Removed from day · still in list')
                  }}
                  onRemove={(placeId) => onChange(removePlanPlace(trip, placeId))}
                />
              ))}

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
            <div className="flex min-h-0 flex-1 flex-col px-2 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
              <div className="mb-2 flex items-end justify-between gap-2 px-1">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                    Days
                  </h2>
                  <p className="text-[11px] text-[var(--ink-muted)]">
                    {selectedUnscheduledId
                      ? 'Tap a day on the right to drop it in'
                      : 'Pick a saved place, then drop it into a day'}
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 gap-2">
                {/* Left — unscheduled lists */}
                <div
                  className={`plan-days-rail w-[42%] min-w-0 shrink-0 ${TOUCH_SCROLL_Y}`}
                >
                  <p className="plan-days-rail-label">Lists</p>
                  {listSections.map((section) => {
                    if (hiddenSections.has(section.id)) return null
                    const places = bySectionUnscheduled(section.id)
                    if (!places.length) return null
                    return (
                      <div key={section.id} className="mb-2.5">
                        <div className="mb-1 flex items-center gap-1.5 px-0.5">
                          <span className="text-sm leading-none" aria-hidden>
                            {section.icon}
                          </span>
                          <span className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                            {section.title}
                          </span>
                          <span className="text-[10px] tabular-nums text-[var(--ink-muted)]">
                            {places.length}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {places.map((p) => {
                            const on =
                              selectedUnscheduledId === p.id || focusPlaceId === p.id
                            return (
                              <button
                                key={p.id}
                                type="button"
                                className={`plan-unscheduled-chip ${on ? 'plan-unscheduled-chip-on' : ''}`}
                                style={{ ['--plan-row-accent' as string]: section.color }}
                                onClick={() => {
                                  const next = on ? null : p.id
                                  setSelectedUnscheduledId(next)
                                  setFocusPlaceId(next)
                                  setFocusSuggestionId(null)
                                  onJourneyHighlight?.(null)
                                }}
                              >
                                <span className="line-clamp-2 text-left text-[12px] font-semibold leading-snug text-[var(--ink)]">
                                  {p.name}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                  {!unscheduled.filter((p) => !hiddenSections.has(p.sectionId)).length ? (
                    <div className="rounded-xl border border-dashed border-[var(--glass-border)] px-2 py-6 text-center">
                      <p className="text-[12px] font-medium text-[var(--ink)]">
                        All scheduled
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--ink-muted)]">
                        Save more ideas in Discover
                      </p>
                      <button
                        type="button"
                        className="mt-3 rounded-full bg-[var(--coral)] px-3 py-1.5 text-[10px] font-semibold text-white"
                        onClick={() => setMode('discover')}
                      >
                        Discover
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Right — day buckets */}
                <div className={`min-w-0 flex-1 space-y-2 ${TOUCH_SCROLL_Y}`}>
                  {days.map((day, idx) => {
                    const places = placesForDay(day)
                    const isActiveMap = !daysAll && daySafe === day
                    return (
                      <div
                        key={day}
                        className={`plan-day-bucket ${isActiveMap ? 'plan-day-bucket-on' : ''}`}
                      >
                        <div className="mb-1.5 flex items-center gap-1">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setDaysAll(false)
                              setActiveDay(day)
                              if (selectedUnscheduledId) {
                                schedulePlace(selectedUnscheduledId, day)
                              }
                            }}
                          >
                            <span className="block text-[13px] font-semibold text-[var(--ink)]">
                              Day {idx + 1}
                            </span>
                            <span className="block text-[10px] text-[var(--ink-muted)]">
                              {weekdayShort(day)} · {day.slice(5)}
                              {places.length
                                ? ` · ${places.length} stop${places.length === 1 ? '' : 's'}`
                                : ' · empty'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="plan-day-opt"
                            title="Optimize this day’s order"
                            aria-label={`Optimize Day ${idx + 1}`}
                            disabled={places.length < 2}
                            onClick={() => {
                              onChange(optimizeDayRoute(trip, day))
                              onStatus?.(`Optimized Day ${idx + 1}`)
                            }}
                          >
                            <AiSparkIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="space-y-1">
                          {places.map((p, i) => {
                            const section = trip.planSections.find((s) => s.id === p.sectionId)
                            return (
                            <div
                              key={p.id}
                              className={`plan-bucket-stop ${focusPlaceId === p.id ? 'plan-bucket-stop-on' : ''}`}
                              style={{
                                ['--plan-row-accent' as string]:
                                  section?.color || 'var(--coral)',
                              }}
                            >
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                onClick={() => {
                                  setDaysAll(false)
                                  setActiveDay(day)
                                  setSelectedUnscheduledId(null)
                                  openSavedPlaceDetail(p.id)
                                }}
                              >
                                <span className="plan-bucket-num">{i + 1}</span>
                                <span className="truncate text-[12px] font-medium text-[var(--ink)]">
                                  {p.name}
                                </span>
                              </button>
                              <div className="flex shrink-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  className="plan-bucket-move"
                                  aria-label="Move up"
                                  disabled={i === 0}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    moveWithinDay(day, p.id, -1)
                                  }}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="plan-bucket-move"
                                  aria-label="Move down"
                                  disabled={i === places.length - 1}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    moveWithinDay(day, p.id, 1)
                                  }}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  className="px-1 text-[10px] font-semibold text-rose-300/90"
                                  aria-label="Unschedule"
                                  onClick={() =>
                                    onChange(unschedulePlanPlace(trip, p.id))
                                  }
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            )
                          })}
                        </div>

                        {selectedUnscheduledId ? (
                          <button
                            type="button"
                            className="plan-drop-zone"
                            onClick={() =>
                              schedulePlace(selectedUnscheduledId, day)
                            }
                          >
                            Drop here
                          </button>
                        ) : !places.length ? (
                          <p className="px-1 py-2 text-center text-[10px] text-[var(--ink-muted)]">
                            Select a place on the left
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
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
  focusPlaceId,
  hidden,
  days,
  onSelect,
  onFocus,
  onSchedule,
  onUnschedule,
  onRemove,
}: {
  section: PlanSection
  places: PlanPlace[]
  active: boolean
  focusPlaceId: string | null
  hidden: boolean
  days: string[]
  onSelect: () => void
  onFocus: (id: string) => void
  onSchedule: (placeId: string, day: string) => void
  onUnschedule: (placeId: string) => void
  onRemove: (placeId: string) => void
}) {
  const [dayMenuFor, setDayMenuFor] = useState<string | null>(null)

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
        {places.map((p) => {
          const dayIdx = p.scheduledDay ? days.indexOf(p.scheduledDay) : -1
          const menuOpen = dayMenuFor === p.id
          const focused = focusPlaceId === p.id
          return (
            <div
              key={p.id}
              data-plan-place-id={p.id}
              className={`plan-list-row ${focused ? 'plan-list-row-on' : ''}`}
              style={{ ['--plan-row-accent' as string]: section.color }}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--ink)]"
                onClick={() => onFocus(p.id)}
              >
                {p.name}
              </button>
              {dayIdx >= 0 ? (
                <button
                  type="button"
                  className="plan-day-badge shrink-0"
                  title={`On Day ${dayIdx + 1} — tap to remove from day`}
                  onClick={() => onUnschedule(p.id)}
                >
                  → D{dayIdx + 1} ✕
                </button>
              ) : null}
              <div className="relative shrink-0">
                <button
                  type="button"
                  className="plan-day-mini"
                  aria-expanded={menuOpen}
                  aria-label={`Schedule ${p.name}`}
                  title="Add to day"
                  onClick={() =>
                    setDayMenuFor((cur) => (cur === p.id ? null : p.id))
                  }
                >
                  {dayIdx >= 0 ? `D${dayIdx + 1}` : 'Day'} ▾
                </button>
                {menuOpen ? (
                  <div className="plan-day-pop" role="menu">
                    {days.map((d, i) => (
                      <button
                        key={d}
                        type="button"
                        role="menuitem"
                        className={`plan-day-pop-item ${p.scheduledDay === d ? 'plan-day-pop-item-on' : ''}`}
                        onClick={() => {
                          onSchedule(p.id, d)
                          setDayMenuFor(null)
                        }}
                      >
                        D{i + 1}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 px-1 text-[11px] text-rose-300/90"
                title="Remove from list"
                onClick={() => onRemove(p.id)}
              >
                ✕
              </button>
            </div>
          )
        })}
        {!places.length ? (
          <p className="px-1 py-2 text-[12px] text-[var(--ink-muted)]">
            Empty — save a suggestion or find a recommendation
          </p>
        ) : null}
      </div>
    </section>
  )
}

function findMatchingListPlace(
  trip: TripRecord,
  place: ExplorePlace,
): PlanPlace | undefined {
  const name = place.name.trim().toLowerCase()
  return trip.planPlaces.find((p) => {
    const section = trip.planSections.find((s) => s.id === p.sectionId)
    const t = (section?.title || '').toLowerCase()
    if (
      t === 'journey' ||
      t === 'on the trip' ||
      section?.title === JOURNEY_SECTION_TITLE
    ) {
      return false
    }
    if (p.name.trim().toLowerCase() !== name) return false
    if (
      isValidCoord(p.lat, p.lon) &&
      isValidCoord(place.lat, place.lon) &&
      (Math.abs(p.lat! - place.lat) > 0.0008 ||
        Math.abs(p.lon! - place.lon) > 0.0008)
    ) {
      return false
    }
    return true
  })
}

function exploreCategoryFromSection(section: PlanSection | undefined): ExploreCategory {
  const t = (section?.title || '').toLowerCase()
  if (t.includes('food') || t.includes('eat') || t.includes('drink')) return 'food'
  if (t.includes('stay') || t.includes('hotel')) return 'hotel'
  if (t.includes('nature') || t.includes('outdoor')) return 'nature'
  if (t.includes('maybe') || t.includes('optional')) return 'other'
  return 'sights'
}

function planPlaceToExplorePlace(
  p: PlanPlace,
  section: PlanSection | undefined,
  days: string[],
  from: { lat: number; lon: number },
): ExplorePlace {
  const dayIdx = p.scheduledDay ? days.indexOf(p.scheduledDay) : -1
  const metaBits = [
    section?.title ? `In ${section.title}` : null,
    dayIdx >= 0 ? `Scheduled · Day ${dayIdx + 1}` : null,
  ].filter(Boolean)
  const summary =
    (p.enrichmentSummary || '').trim() ||
    (p.notes || '').trim() ||
    metaBits.join(' · ') ||
    'Saved place'

  const images = (p.images || []).filter(Boolean)
  if (!images.length && p.enrichmentImage) images.push(p.enrichmentImage)
  if (!images.length && p.googlePhotoName) {
    const url = googlePlacePhotoMediaUrl(p.googlePhotoName)
    if (url) images.push(url)
  }

  return {
    id: p.id,
    name: p.name,
    lat: p.lat ?? 0,
    lon: p.lon ?? 0,
    category: exploreCategoryFromSection(section),
    osmType: 'plan',
    osmId: p.osmId || '',
    wikidata: '',
    images,
    summary,
    distKm:
      isValidCoord(p.lat, p.lon) && isValidCoord(from.lat, from.lon)
        ? distKm(from, { lat: p.lat!, lon: p.lon! })
        : 0,
    rating: p.rating ?? null,
    cuisine: p.cuisine || '',
    website: p.url || '',
    menuUrl: '',
    openingHours: p.openingHours || '',
    openingPeriods: p.openingPeriods?.length ? p.openingPeriods : undefined,
    address: [p.place, p.city].filter(Boolean).join(', '),
    tags: {
      source: p.googlePhotoName || p.osmId.startsWith('google:') ? 'google' : 'plan',
      ...(p.googleMapsUri ? { googleMapsUri: p.googleMapsUri } : {}),
      ...(p.googlePhotoName ? { googlePhotoName: p.googlePhotoName } : {}),
    },
  }
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
