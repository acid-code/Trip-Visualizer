/**
 * Trip Planner — ingest, area tips, adapt, reshape, enrich (no hotel names).
 * Client orchestrates; Gemini structures JSON via /api/agent.
 */

import type { TripItem, TripRecord } from '../domain/types'
import { lookupPlace } from '../data/enrichment'
import { fetchNearbyExplore, type ExplorePlace } from '../data/explore'
import {
  addPlanPlace,
  ensurePlanScaffold,
  planMaybeSection,
  planSectionForExploreCategory,
} from '../data/planBoard'
import { createId, nowIso } from '../data/db'
import {
  enumerateDays,
  ensureDayStartBases,
  isPlaceholderBase,
} from '../data/dayBases'
import { isIsoDate, isValidCoord } from '../data/validate'
import { mergePlannerPrefs, prefsFromMeta } from './context/compileDayBriefing'
import {
  markPlacesUnhealthy,
  resolvePlaceProvider,
  useGooglePlacesNow,
} from './placeProvider'
import type {
  AreaTip,
  AreaKnowHow,
  Caveat,
  FullTripDayPlan,
  FullTripDraft,
  FullTripHighlight,
  PlannerPrefs,
  TransportHint,
  TripDraftDecision,
  TripIngestDraftItem,
  TripItemUpdate,
  TripPlannerResult,
  TripSpineOption,
} from './types'

async function postAgent(
  mode: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, ...payload }),
    signal,
  })
  const data = (await res.json()) as unknown
  if (!res.ok) {
    const err =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Agent failed (${res.status})`
    throw new Error(err)
  }
  return data
}

function clampTip(raw: unknown, i: number): AreaTip | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const areaLabel = String(o.areaLabel ?? o.label ?? '').trim().slice(0, 120)
  if (!areaLabel) return null
  const neighborhoodsRaw = Array.isArray(o.neighborhoods) ? o.neighborhoods : []
  const neighborhoods = neighborhoodsRaw
    .map((n) => {
      if (!n || typeof n !== 'object') return null
      const x = n as Record<string, unknown>
      const label = String(x.label ?? '').trim().slice(0, 120)
      if (!label) return null
      return {
        label,
        vibeTags: Array.isArray(x.vibeTags)
          ? x.vibeTags.map((t) => String(t).slice(0, 40)).slice(0, 6)
          : [],
        nightWalk:
          typeof x.nightWalk === 'boolean' ? x.nightWalk : undefined,
        budgetFit: x.budgetFit ? String(x.budgetFit).slice(0, 80) : undefined,
        whyStayHere: String(x.whyStayHere ?? x.why ?? '').slice(0, 280),
        anchorLat: null as number | null,
        anchorLon: null as number | null,
        samplePlaceIds: [] as string[],
      }
    })
    .filter(Boolean) as AreaTip['neighborhoods']

  const hint = String(o.transportHint ?? 'transit_ok')
  const transportHint: TransportHint =
    hint === 'walk_city' ||
    hint === 'car_useful' ||
    hint === 'car_needed' ||
    hint === 'transit_ok'
      ? hint
      : 'transit_ok'

  return {
    id: String(o.id ?? `area-${i}`).slice(0, 64),
    areaLabel,
    country: String(o.country ?? '').slice(0, 80),
    vibeTags: Array.isArray(o.vibeTags)
      ? o.vibeTags.map((t) => String(t).slice(0, 40)).slice(0, 8)
      : [],
    whyGo: String(o.whyGo ?? '').slice(0, 400),
    roughNights: Math.max(
      1,
      Math.min(14, Number(o.roughNights) || 2),
    ),
    transportHint,
    neighborhoods:
      neighborhoods.length > 0
        ? neighborhoods
        : [
            {
              label: areaLabel,
              vibeTags: [],
              whyStayHere: 'Main stay zone',
              anchorLat: null,
              anchorLon: null,
              samplePlaceIds: [],
            },
          ],
    caveatsLite: Array.isArray(o.caveatsLite)
      ? o.caveatsLite.map((c) => String(c).slice(0, 200)).slice(0, 6)
      : [],
  }
}

async function geocodeAreaTip(tip: AreaTip): Promise<AreaTip> {
  const neighborhoods = []
  for (const n of tip.neighborhoods) {
    const q = `${n.label}, ${tip.areaLabel}, ${tip.country}`.trim()
    try {
      const hit = await lookupPlace(q, { useGooglePlaces: useGooglePlacesNow() })
      neighborhoods.push({
        ...n,
        anchorLat: hit?.lat ?? null,
        anchorLon: hit?.lon ?? null,
      })
    } catch {
      neighborhoods.push(n)
    }
  }
  return { ...tip, neighborhoods }
}

async function samplePlacesNear(
  lat: number,
  lon: number,
): Promise<ExplorePlace[]> {
  try {
    return await fetchNearbyExplore(
      { lat, lon },
      {
        categories: ['sights', 'food', 'nature'],
        radiusM: 2500,
        limit: 12,
        useGooglePlaces: useGooglePlacesNow(),
      },
    )
  } catch (e) {
    markPlacesUnhealthy(e instanceof Error ? e.message : String(e))
    return fetchNearbyExplore(
      { lat, lon },
      {
        categories: ['sights', 'food', 'nature'],
        radiusM: 2500,
        limit: 12,
        useGooglePlaces: false,
      },
    )
  }
}

/** Attach Overpass/Google samples to neighborhood anchors. */
export async function enrichAreaTipSamples(tip: AreaTip): Promise<AreaTip> {
  const neighborhoods = []
  for (const n of tip.neighborhoods) {
    if (!isValidCoord(n.anchorLat, n.anchorLon)) {
      neighborhoods.push(n)
      continue
    }
    const places = await samplePlacesNear(n.anchorLat!, n.anchorLon!)
    neighborhoods.push({
      ...n,
      samplePlaceIds: places.slice(0, 6).map((p) => p.id),
    })
  }
  return { ...tip, neighborhoods }
}

export async function requestAreaTips(args: {
  trip: TripRecord
  userMessage?: string
  countries?: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  await resolvePlaceProvider({ signal: args.signal })
  const prefs = prefsFromMeta(args.trip)
  let data: unknown
  try {
    data = await postAgent(
      'area_tips',
      {
        tripName: args.trip.meta.name,
        vibe: args.trip.meta.vibe,
        dates: {
          start: args.trip.meta.startDate,
          end: args.trip.meta.endDate,
        },
        travelers: args.trip.meta.travelers,
        notes: args.trip.meta.notes.slice(0, 800),
        prefs,
        countries: args.countries || '',
        userMessage: (args.userMessage || 'Suggest areas to consider').slice(
          0,
          1500,
        ),
        hardRules: [
          'Never suggest specific hotel names or bookings.',
          'Recommend city/region and best neighborhoods only.',
          'Include transportHint (walk_city|transit_ok|car_useful|car_needed).',
        ],
      },
      args.signal,
    )
  } catch {
    return localAreaTipsFallback(args.trip, args.countries || args.userMessage || '')
  }

  const tipsRaw =
    data && typeof data === 'object' && Array.isArray((data as { tips?: unknown }).tips)
      ? (data as { tips: unknown[] }).tips
      : []
  let tips = tipsRaw
    .map((t, i) => clampTip(t, i))
    .filter(Boolean) as AreaTip[]
  if (!tips.length) {
    return localAreaTipsFallback(args.trip, args.countries || '')
  }
  tips = await Promise.all(tips.slice(0, 6).map((t) => geocodeAreaTip(t)))
  tips = await Promise.all(tips.map((t) => enrichAreaTipSamples(t)))
  return { kind: 'area_tips', tips }
}

function localAreaTipsFallback(
  trip: TripRecord,
  hint: string,
): TripPlannerResult {
  const label =
    hint.trim().slice(0, 80) ||
    trip.meta.name ||
    'Your destination'
  return {
    kind: 'area_tips',
    tips: [
      {
        id: 'local-1',
        areaLabel: label,
        country: '',
        vibeTags: prefsFromMeta(trip).vibe || [],
        whyGo: 'Start by picking a neighborhood stay-zone; book lodging yourself.',
        roughNights: Math.max(
          1,
          Math.min(
            14,
            Math.round(
              (Date.parse(trip.meta.endDate) - Date.parse(trip.meta.startDate)) /
                86400000,
            ) || 3,
          ),
        ),
        transportHint: 'transit_ok',
        neighborhoods: [
          {
            label: `Central ${label}`,
            vibeTags: ['walkable'],
            whyStayHere: 'Good default base until you refine.',
            anchorLat: null,
            anchorLon: null,
            samplePlaceIds: [],
          },
        ],
        caveatsLite: [
          'Google Places may be unavailable — tips use OSM/Nominatim when needed.',
          'Never treat AI area tips as hotel bookings.',
        ],
      },
    ],
  }
}

export async function ingestFreeText(args: {
  trip: TripRecord
  freeText: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  await resolvePlaceProvider({ signal: args.signal })
  try {
    const data = await postAgent(
      'trip_ingest',
      {
        tripName: args.trip.meta.name,
        dates: {
          start: args.trip.meta.startDate,
          end: args.trip.meta.endDate,
        },
        freeText: args.freeText.slice(0, 8000),
        hardRules: [
          'Extract flights/trains/user-named hotels from text only — never invent hotel names.',
          'Soft wants → planPlaceNames (must/food/maybe), not fake bookings.',
          'Mark uncertain legs tentative.',
          'Propose 2-3 extreme spine options (areas only).',
        ],
      },
      args.signal,
    )
    return parseIngestResult(data)
  } catch {
    return {
      kind: 'ingest_draft',
      items: [],
      planPlaceNames: [],
      openQuestions: [
        'Could not reach the AI — paste again later, or add flights/areas manually.',
      ],
      prefs: { notes: [args.freeText.slice(0, 300)] },
    }
  }
}

function parseIngestResult(data: unknown): TripPlannerResult {
  if (!data || typeof data !== 'object') {
    return {
      kind: 'ingest_draft',
      items: [],
      planPlaceNames: [],
      openQuestions: ['Empty AI response'],
    }
  }
  const o = data as Record<string, unknown>
  if (o.kind === 'need_clarification') {
    return {
      kind: 'need_clarification',
      question: String(o.question || 'Can you clarify the trip dates or countries?'),
    }
  }
  const items: TripIngestDraftItem[] = Array.isArray(o.items)
    ? o.items
        .map((it) => {
          if (!it || typeof it !== 'object') return null
          const x = it as Record<string, unknown>
          const title = String(x.title ?? '').trim()
          if (!title) return null
          const conf = String(x.confidence ?? 'medium')
          return {
            type: String(x.type ?? 'note').slice(0, 20),
            title: title.slice(0, 300),
            place: String(x.place ?? '').slice(0, 500),
            city: String(x.city ?? '').slice(0, 120),
            date: String(x.date ?? '').slice(0, 10),
            endDate: x.endDate ? String(x.endDate).slice(0, 10) : undefined,
            start: x.start ? String(x.start).slice(0, 5) : undefined,
            end: x.end ? String(x.end).slice(0, 5) : undefined,
            from: x.from ? String(x.from).slice(0, 200) : undefined,
            to: x.to ? String(x.to).slice(0, 200) : undefined,
            notes: x.notes ? String(x.notes).slice(0, 1000) : undefined,
            confidence:
              conf === 'high' || conf === 'low' || conf === 'medium'
                ? conf
                : 'medium',
            source: 'user_text' as const,
            tentative: Boolean(x.tentative),
          }
        })
        .filter(Boolean) as TripIngestDraftItem[]
    : []

  const planPlaceNames = Array.isArray(o.planPlaceNames)
    ? o.planPlaceNames
        .map((p) => {
          if (!p || typeof p !== 'object') return null
          const x = p as Record<string, unknown>
          const name = String(x.name ?? '').trim()
          if (!name) return null
          const section = String(x.section ?? 'maybe')
          return {
            name: name.slice(0, 300),
            section:
              section === 'must' || section === 'food' || section === 'maybe'
                ? section
                : ('maybe' as const),
            city: x.city ? String(x.city).slice(0, 120) : undefined,
          }
        })
        .filter(Boolean) as Array<{
        name: string
        section: 'must' | 'food' | 'maybe'
        city?: string
      }>
    : []

  const spineOptions = Array.isArray(o.spineOptions)
    ? (o.spineOptions
        .map((s, i) => parseSpine(s, i))
        .filter(Boolean) as TripSpineOption[])
    : undefined

  return {
    kind: 'ingest_draft',
    items: items.slice(0, 40),
    planPlaceNames: planPlaceNames.slice(0, 40),
    openQuestions: Array.isArray(o.openQuestions)
      ? o.openQuestions.map((q) => String(q).slice(0, 240)).slice(0, 8)
      : [],
    prefs: o.prefs && typeof o.prefs === 'object' ? (o.prefs as Partial<PlannerPrefs>) : undefined,
    spineOptions,
  }
}

function parseSpine(raw: unknown, i: number): TripSpineOption | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = String(o.label ?? '').trim()
  if (!label) return null
  const areas = Array.isArray(o.areas)
    ? o.areas
        .map((a) => {
          if (!a || typeof a !== 'object') return null
          const x = a as Record<string, unknown>
          const al = String(x.label ?? '').trim()
          if (!al) return null
          const th = String(x.transportHint ?? 'transit_ok')
          return {
            label: al.slice(0, 120),
            roughNights: Math.max(1, Math.min(14, Number(x.roughNights) || 2)),
            transportHint: (
              ['walk_city', 'transit_ok', 'car_useful', 'car_needed'].includes(th)
                ? th
                : 'transit_ok'
            ) as TransportHint,
            theme: x.theme ? String(x.theme).slice(0, 80) : undefined,
            why: x.why ? String(x.why).slice(0, 240) : undefined,
          }
        })
        .filter(Boolean)
    : []
  return {
    id: String(o.id ?? `spine-${i}`).slice(0, 64),
    label: label.slice(0, 80),
    summary: String(o.summary ?? '').slice(0, 400),
    why: o.why ? String(o.why).slice(0, 280) : undefined,
    areas: areas as TripSpineOption['areas'],
    openQuestions: Array.isArray(o.openQuestions)
      ? o.openQuestions.map((q) => String(q).slice(0, 200)).slice(0, 4)
      : [],
  }
}

export async function requestSpineOptions(args: {
  trip: TripRecord
  userMessage: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  await resolvePlaceProvider({ signal: args.signal })
  try {
    const data = await postAgent(
      'trip_spine',
      {
        tripName: args.trip.meta.name,
        vibe: args.trip.meta.vibe,
        dates: {
          start: args.trip.meta.startDate,
          end: args.trip.meta.endDate,
        },
        prefs: prefsFromMeta(args.trip),
        userMessage: args.userMessage.slice(0, 2000),
        hardRules: [
          '2-3 extreme spine options: ordered areas/neighborhoods only.',
          'Never name specific hotels.',
          'Ask about car if hops look car_useful.',
        ],
      },
      args.signal,
    )
    const o = data as Record<string, unknown>
    if (o.kind === 'need_clarification') {
      return {
        kind: 'need_clarification',
        question: String(o.question || 'Which countries or regions?'),
      }
    }
    const options = Array.isArray(o.options)
      ? (o.options.map((s, i) => parseSpine(s, i)).filter(Boolean) as TripSpineOption[])
      : []
    return {
      kind: 'spine_options',
      options: options.slice(0, 3),
      prefs: o.prefs && typeof o.prefs === 'object' ? (o.prefs as Partial<PlannerPrefs>) : undefined,
    }
  } catch {
    return {
      kind: 'need_clarification',
      question: 'Which country or region should the spine focus on?',
    }
  }
}

export async function reshapeTrip(args: {
  trip: TripRecord
  userMessage: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  await resolvePlaceProvider({ signal: args.signal })
  const briefing = compactTripBriefing(args.trip)
  try {
    const data = await postAgent(
      'trip_reshape',
      {
        briefing,
        prefs: prefsFromMeta(args.trip),
        existingSteps: existingStepsBrief(args.trip),
        userMessage: args.userMessage.slice(0, 2000),
        hardRules: [
          'Prefer patches over full rewrite.',
          'Protect confirmed flights; use itemUpdates for times/from/to when user provides them.',
          'Never invent hotels.',
          'If user changes area, say so clearly for adaptSegment.',
        ],
      },
      args.signal,
    )
    const o = data as Record<string, unknown>
    if (o.kind === 'need_clarification') {
      return {
        kind: 'need_clarification',
        question: String(o.question || 'What should change?'),
      }
    }
    return {
      kind: 'reshape',
      summary: String(o.summary || 'Suggested trip adjustments').slice(0, 800),
      prefs: o.prefs && typeof o.prefs === 'object' ? (o.prefs as Partial<PlannerPrefs>) : undefined,
      openQuestions: Array.isArray(o.openQuestions)
        ? o.openQuestions.map((q) => String(q).slice(0, 200)).slice(0, 6)
        : [],
      spineOptions: Array.isArray(o.spineOptions)
        ? (o.spineOptions.map((s, i) => parseSpine(s, i)).filter(Boolean) as TripSpineOption[])
        : undefined,
    }
  } catch {
    return {
      kind: 'reshape',
      summary: 'AI unavailable — try editing areas manually in Plan.',
      openQuestions: [],
    }
  }
}

function compactTripBriefing(trip: TripRecord): string {
  return JSON.stringify({
    name: trip.meta.name,
    dates: [trip.meta.startDate, trip.meta.endDate],
    vibe: trip.meta.vibe,
    areas: prefsFromMeta(trip).adoptedAreas || [],
    existingSteps: existingStepsBrief(trip),
    planCount: trip.planPlaces?.length ?? 0,
  }).slice(0, 4000)
}

/** Compact list of real Journey steps for the model (esp. flights). */
export function existingStepsBrief(trip: TripRecord): Array<{
  id: string
  type: string
  title: string
  date: string
  endDate: string
  start: string
  end: string
  from: string
  to: string
  place: string
  city: string
  status: string
  confirm: string
}> {
  return trip.items
    .filter((i) => !isPlaceholderBase(i) && i.status !== 'cancelled')
    .slice(0, 40)
    .map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title.slice(0, 120),
      date: i.date,
      endDate: i.endDate || '',
      start: i.start || '',
      end: i.end || '',
      from: i.from || '',
      to: i.to || '',
      place: i.place || '',
      city: i.city || '',
      status: i.status,
      confirm: i.confirm ? '[set]' : '',
    }))
}

export function applyItemUpdates(
  trip: TripRecord,
  updates: TripItemUpdate[],
): TripRecord {
  if (!updates.length) return trip
  const byId = new Map(updates.map((u) => [u.itemId, u]))
  return {
    ...trip,
    items: trip.items.map((it) => {
      const u = byId.get(it.id)
      if (!u) return it
      return {
        ...it,
        title: u.title !== undefined ? u.title.slice(0, 200) : it.title,
        start: u.start !== undefined ? u.start.slice(0, 8) : it.start,
        end: u.end !== undefined ? u.end.slice(0, 8) : it.end,
        from: u.from !== undefined ? u.from.slice(0, 120) : it.from,
        to: u.to !== undefined ? u.to.slice(0, 120) : it.to,
        date: u.date && isIsoDate(u.date) ? u.date : it.date,
        endDate:
          u.endDate !== undefined
            ? isIsoDate(u.endDate)
              ? u.endDate
              : it.endDate
            : it.endDate,
        notes:
          u.notes !== undefined
            ? `${it.notes}\n${u.notes}`.trim().slice(0, 5000)
            : it.notes,
        place: u.place !== undefined ? u.place.slice(0, 200) : it.place,
        city: u.city !== undefined ? u.city.slice(0, 120) : it.city,
        updatedAt: nowIso(),
      }
    }),
    updatedAt: nowIso(),
  }
}

function transitCorridorKey(type: string, date: string, from: string, to: string, title: string): string {
  return [
    type.toLowerCase(),
    date,
    from.toLowerCase().slice(0, 40),
    to.toLowerCase().slice(0, 40),
    title.toLowerCase().slice(0, 40),
  ].join('|')
}

function parseItemUpdates(raw: unknown): TripItemUpdate[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((u) => {
      if (!u || typeof u !== 'object') return null
      const x = u as Record<string, unknown>
      const itemId = String(x.itemId ?? x.id ?? '').trim()
      if (!itemId) return null
      const out: TripItemUpdate = { itemId: itemId.slice(0, 64) }
      if (x.title != null) out.title = String(x.title).slice(0, 200)
      if (x.start != null) out.start = String(x.start).slice(0, 8)
      if (x.end != null) out.end = String(x.end).slice(0, 8)
      if (x.from != null) out.from = String(x.from).slice(0, 120)
      if (x.to != null) out.to = String(x.to).slice(0, 120)
      if (x.date != null) out.date = String(x.date).slice(0, 10)
      if (x.endDate != null) out.endDate = String(x.endDate).slice(0, 10)
      if (x.notes != null) out.notes = String(x.notes).slice(0, 400)
      if (x.place != null) out.place = String(x.place).slice(0, 200)
      if (x.city != null) out.city = String(x.city).slice(0, 120)
      return out
    })
    .filter(Boolean)
    .slice(0, 30) as TripItemUpdate[]
}

/**
 * Adapt trip when user picks a different area/neighborhood.
 * Drops list bias notes for old area; sets day-base anchors; merges prefs.
 */
export async function adaptSegmentToArea(args: {
  trip: TripRecord
  dropAreaLabels: string[]
  adopt: AreaTip
  signal?: AbortSignal
}): Promise<TripRecord> {
  let tip = await geocodeAreaTip(args.adopt)
  tip = await enrichAreaTipSamples(tip)
  const neigh = tip.neighborhoods[0]
  let trip = mergePlannerPrefs(args.trip, {
    adoptedAreas: [
      ...(prefsFromMeta(args.trip).adoptedAreas || []).filter(
        (a) =>
          !args.dropAreaLabels.some(
            (d) => d.toLowerCase() === a.toLowerCase(),
          ),
      ),
      tip.areaLabel,
      ...(neigh ? [neigh.label] : []),
    ].slice(0, 24),
    notes: [`Adapted stay zone to ${tip.areaLabel}`],
    transport:
      tip.transportHint === 'car_needed' || tip.transportHint === 'car_useful'
        ? 'car'
        : prefsFromMeta(args.trip).transport,
  })

  // Update placeholder day bases that match dropped labels / lack coords
  const drop = args.dropAreaLabels.map((s) => s.toLowerCase())
  trip = {
    ...trip,
    items: trip.items.map((it) => {
      if (!isPlaceholderBase(it)) return it
      const blob = `${it.title} ${it.place}`.toLowerCase()
      const touchesDrop = drop.some((d) => d && blob.includes(d))
      if (!touchesDrop && isValidCoord(it.lat, it.lon)) return it
      if (!neigh || !isValidCoord(neigh.anchorLat, neigh.anchorLon)) return it
      return {
        ...it,
        title: `${neigh.label} base`,
        place: `${neigh.label}, ${tip.areaLabel}`,
        city: tip.areaLabel,
        lat: neigh.anchorLat,
        lon: neigh.anchorLon,
        notes: `Area stay-zone (not a hotel). ${neigh.whyStayHere}`.slice(0, 500),
        updatedAt: nowIso(),
      }
    }),
    updatedAt: nowIso(),
  }

  // Soft-clear plan place notes that only referenced old area (keep places)
  if (drop.length) {
    trip = {
      ...trip,
      planPlaces: (trip.planPlaces || []).map((p) => {
        const blob = `${p.name} ${p.city} ${p.notes}`.toLowerCase()
        if (!drop.some((d) => d && blob.includes(d))) return p
        return {
          ...p,
          notes: `${p.notes}\n[Area changed → ${tip.areaLabel}]`.slice(0, 5000),
        }
      }),
    }
  }

  return trip
}

/** Apply ingest draft items the user checked. */
export function applyIngestDraft(
  trip: TripRecord,
  items: TripIngestDraftItem[],
  planPlaceNames: Array<{
    name: string
    section: 'must' | 'food' | 'maybe'
    city?: string
    why?: string
  }>,
): TripRecord {
  let next = ensurePlanScaffold(trip)
  if (items.length) {
    const newItems: TripItem[] = items
      .filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date))
      .map((i) => ({
        id: createId(i.type[0]?.toUpperCase() || 'X'),
        type: (['flight', 'train', 'bus', 'ferry', 'drive', 'hotel', 'sight', 'restaurant', 'activity', 'city', 'note', 'other'].includes(i.type)
          ? i.type
          : 'note') as TripItem['type'],
        title: i.title,
        place: i.place,
        city: i.city,
        date: i.date,
        endDate: i.endDate || '',
        start: i.start || '',
        end: i.end || '',
        from: i.from || '',
        to: i.to || '',
        confirm: '',
        cost: null,
        currency: '',
        status: i.tentative ? 'planned' : 'booked',
        notes: `${i.notes || ''}${i.tentative ? '\n[tentative]' : ''}\n[from free-text ingest · ${i.confidence}]`.trim(),
        url: '',
        tags: i.tentative ? ['tentative', 'from-ingest'] : ['from-ingest'],
        lat: null,
        lon: null,
        latTo: null,
        lonTo: null,
        wikidata: '',
        osmId: '',
        rating: null,
        googleMapsUri: '',
        geocodeQuery: '',
        updatedAt: nowIso(),
        enrichmentSummary: '',
        enrichmentImage: '',
        enrichmentSource: '',
        routeCoords: [],
        source: 'app' as const,
      }))
    next = { ...next, items: [...next.items, ...newItems] }
  }

  for (const p of planPlaceNames) {
    const section =
      p.section === 'maybe'
        ? planMaybeSection(next)
        : planSectionForExploreCategory(
            next,
            p.section === 'food' ? 'food' : 'sights',
          ) || planMaybeSection(next)
    if (!section) continue
    next = addPlanPlace(next, {
      sectionId: section.id,
      name: p.name,
      city: p.city || '',
      notes: p.why
        ? `Why: ${p.why}`
        : 'From free-text ingest (unscheduled)',
    })
  }
  return { ...next, updatedAt: nowIso() }
}

const NON_HOTEL_ITEM_TYPES = new Set([
  'flight',
  'train',
  'bus',
  'ferry',
  'drive',
  'sight',
  'restaurant',
  'activity',
  'city',
  'note',
  'other',
])

/**
 * Spread spine area nights across the trip calendar (latest nights win if oversold).
 * Pure — used by compose + tests.
 */
export function allocateSpineToDays(
  startDate: string,
  endDate: string,
  areas: TripSpineOption['areas'],
): FullTripDayPlan[] {
  const days = enumerateDays(startDate, endDate)
  if (!days.length || !areas.length) return []

  const totalNights = areas.reduce((s, a) => s + Math.max(1, a.roughNights), 0)
  const out: FullTripDayPlan[] = []
  let cursor = 0
  for (let ai = 0; ai < areas.length; ai++) {
    const area = areas[ai]!
    const share =
      ai === areas.length - 1
        ? days.length - cursor
        : Math.max(
            1,
            Math.round((area.roughNights / totalNights) * days.length),
          )
    const take = Math.min(Math.max(1, share), days.length - cursor)
    for (let i = 0; i < take && cursor < days.length; i++, cursor++) {
      out.push({
        date: days[cursor]!,
        areaLabel: area.label,
        theme: area.theme || area.label,
        why: area.why,
        highlights: [],
      })
    }
  }
  while (cursor < days.length) {
    const last = areas[areas.length - 1]!
    out.push({
      date: days[cursor]!,
      areaLabel: last.label,
      theme: last.theme || last.label,
      why: last.why,
      highlights: [],
    })
    cursor++
  }
  return out
}

function parseHighlight(raw: unknown): FullTripHighlight | null {
  if (typeof raw === 'string') {
    const name = raw.trim()
    if (!name) return null
    return { name: name.slice(0, 80), why: '' }
  }
  if (!raw || typeof raw !== 'object') return null
  const x = raw as Record<string, unknown>
  const name = String(x.name ?? x.title ?? x.label ?? '').trim()
  if (!name) return null
  return {
    name: name.slice(0, 80),
    why: String(x.why ?? x.reason ?? '').slice(0, 240),
  }
}

function parseDayPlan(raw: unknown, fallback: FullTripDayPlan[]): FullTripDayPlan[] {
  if (!Array.isArray(raw) || !raw.length) return fallback
  const parsed = raw
    .map((d) => {
      if (!d || typeof d !== 'object') return null
      const x = d as Record<string, unknown>
      const date = String(x.date ?? '').trim()
      const areaLabel = String(x.areaLabel ?? x.area ?? '').trim()
      if (!isIsoDate(date) || !areaLabel) return null
      const highlights = Array.isArray(x.highlights)
        ? (x.highlights.map(parseHighlight).filter(Boolean) as FullTripHighlight[]).slice(
            0,
            6,
          )
        : []
      return {
        date,
        areaLabel: areaLabel.slice(0, 120),
        theme: String(x.theme ?? areaLabel).slice(0, 120),
        why: x.why ? String(x.why).slice(0, 280) : undefined,
        highlights,
        special:
          x.special === true ||
          String(x.special ?? '').toLowerCase() === 'true' ||
          undefined,
      }
    })
    .filter(Boolean) as FullTripDayPlan[]
  return parsed.length ? parsed : fallback
}

function parseDecisions(raw: unknown): TripDraftDecision[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((d) => {
      if (!d || typeof d !== 'object') return null
      const x = d as Record<string, unknown>
      const what = String(x.what ?? x.label ?? '').trim()
      const why = String(x.why ?? x.reason ?? '').trim()
      if (!what || !why) return null
      return { what: what.slice(0, 120), why: why.slice(0, 320) }
    })
    .filter(Boolean)
    .slice(0, 16) as TripDraftDecision[]
}

function parseComposeItems(raw: unknown): TripIngestDraftItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => {
      if (!it || typeof it !== 'object') return null
      const x = it as Record<string, unknown>
      const type = String(x.type ?? 'note').toLowerCase()
      if (type === 'hotel' || !NON_HOTEL_ITEM_TYPES.has(type)) return null
      const title = String(x.title ?? '').trim()
      const date = String(x.date ?? '').trim()
      if (!title || !isIsoDate(date)) return null
      return {
        type,
        title: title.slice(0, 200),
        place: String(x.place ?? '').slice(0, 200),
        city: String(x.city ?? '').slice(0, 120),
        date,
        endDate: x.endDate ? String(x.endDate).slice(0, 10) : undefined,
        start: x.start ? String(x.start).slice(0, 8) : undefined,
        end: x.end ? String(x.end).slice(0, 8) : undefined,
        from: x.from ? String(x.from).slice(0, 80) : undefined,
        to: x.to ? String(x.to).slice(0, 80) : undefined,
        notes: x.notes ? String(x.notes).slice(0, 400) : undefined,
        confidence: (['high', 'medium', 'low'].includes(String(x.confidence))
          ? String(x.confidence)
          : 'medium') as 'high' | 'medium' | 'low',
        source: (['user_text', 'inferred', 'web'].includes(String(x.source))
          ? String(x.source)
          : 'inferred') as 'user_text' | 'inferred' | 'web',
        tentative: x.tentative !== false,
      }
    })
    .filter(Boolean)
    .slice(0, 30) as TripIngestDraftItem[]
}

function parseFullTripDraft(
  data: unknown,
  trip: TripRecord,
): FullTripDraft | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const spine =
    parseSpine(o.spine, 0) ||
    (Array.isArray(o.spineOptions)
      ? parseSpine(o.spineOptions[0], 0)
      : null)
  if (!spine || !spine.areas.length) return null

  const fallbackDays = allocateSpineToDays(
    trip.meta.startDate,
    trip.meta.endDate,
    spine.areas,
  )
  const dayPlan = parseDayPlan(o.dayPlan, fallbackDays)
  const planPlaceNames = Array.isArray(o.planPlaceNames)
    ? o.planPlaceNames
        .map((p) => {
          if (!p || typeof p !== 'object') return null
          const x = p as Record<string, unknown>
          const name = String(x.name ?? '').trim()
          if (!name) return null
          const section = String(x.section ?? 'must')
          return {
            name: name.slice(0, 120),
            section: (section === 'food' || section === 'maybe'
              ? section
              : 'must') as 'must' | 'food' | 'maybe',
            city: x.city ? String(x.city).slice(0, 80) : undefined,
            why: x.why ? String(x.why).slice(0, 240) : undefined,
          }
        })
        .filter(Boolean)
        .slice(0, 40) as FullTripDraft['planPlaceNames']
    : []

  const decisions = parseDecisions(o.decisions)
  // Fallback decisions from spine/day why so the UI always has something human
  const autoDecisions: TripDraftDecision[] = []
  if (spine.why) {
    autoDecisions.push({ what: `Route: ${spine.label}`, why: spine.why })
  }
  for (const a of spine.areas) {
    if (a.why) autoDecisions.push({ what: `Stay near ${a.label}`, why: a.why })
  }

  return {
    summary: String(o.summary ?? spine.summary ?? 'Full trip draft').slice(0, 800),
    titleSuggestion: o.titleSuggestion
      ? String(o.titleSuggestion).slice(0, 80)
      : undefined,
    spine,
    dayPlan,
    planPlaceNames,
    items: parseComposeItems(o.items),
    itemUpdates: parseItemUpdates(o.itemUpdates),
    prefs:
      o.prefs && typeof o.prefs === 'object'
        ? (o.prefs as Partial<PlannerPrefs>)
        : undefined,
    openQuestions: Array.isArray(o.openQuestions)
      ? o.openQuestions.map((q) => String(q).slice(0, 240)).slice(0, 8)
      : spine.openQuestions,
    droppedHighlights: Array.isArray(o.droppedHighlights)
      ? o.droppedHighlights.map((h) => String(h).slice(0, 80)).slice(0, 40)
      : undefined,
    decisions: (decisions.length ? decisions : autoDecisions).slice(0, 16),
  }
}

/**
 * Materialize a model full-trip draft onto the journey: area day-bases,
 * themes/highlights as notes/sights, plan seeds — never invents hotels.
 * Merges itemUpdates onto existing steps; skips duplicate transit.
 */
function fingerprintDraftStructure(
  draft: FullTripDraft,
  dayPlan: FullTripDayPlan[],
): string {
  const days = dayPlan
    .map((d) => `${d.date}:${d.areaLabel.trim().toLowerCase()}`)
    .join(',')
  const spine = draft.spine.areas
    .map((a) => a.label.trim().toLowerCase())
    .join('>')
  return `${spine}|${days}`.slice(0, 500)
}

export function applyFullTripDraft(
  trip: TripRecord,
  draft: FullTripDraft,
): TripRecord {
  const dayPlan =
    draft.dayPlan.length > 0
      ? draft.dayPlan
      : allocateSpineToDays(
          trip.meta.startDate,
          trip.meta.endDate,
          draft.spine.areas,
        )
  const byDate = new Map(dayPlan.map((d) => [d.date, d]))
  const dropped = new Set(
    (draft.droppedHighlights || []).map((h) => h.toLowerCase()),
  )

  let next = applyItemUpdates(trip, draft.itemUpdates || [])
  next = ensurePlanScaffold(next)
  next = {
    ...next,
    items: ensureDayStartBases(next.meta, next.items),
  }

  const areaLabels = [
    ...draft.spine.areas.map((a) => a.label),
    ...dayPlan.map((d) => d.areaLabel),
  ].filter(Boolean)

  next = mergePlannerPrefs(next, {
    ...(draft.prefs || {}),
    adoptedAreas: [
      ...(prefsFromMeta(next).adoptedAreas || []),
      ...areaLabels,
    ].slice(0, 24),
    notes: [
      ...(draft.prefs?.notes || []),
      `Full trip AI: ${draft.spine.label}`,
    ].slice(0, 12),
    structureAppliedAt: Date.now(),
    structureFingerprint: fingerprintDraftStructure(draft, dayPlan),
  })

  if (draft.titleSuggestion && !String(next.meta.name || '').trim()) {
    next = {
      ...next,
      meta: { ...next.meta, name: draft.titleSuggestion },
    }
  }

  next = {
    ...next,
    items: next.items.map((it) => {
      if (!isPlaceholderBase(it)) return it
      const day = byDate.get(it.date)
      if (!day) return it
      return {
        ...it,
        title: `${day.areaLabel} base`,
        place: day.areaLabel,
        city: day.areaLabel,
        geocodeQuery: day.areaLabel,
        notes: `Area stay-zone (not a hotel). ${day.theme}.${
          day.why ? ` ${day.why}` : ''
        }`.slice(0, 500),
        tags: ['day-base', 'placeholder', 'from-full-trip-ai'],
        updatedAt: nowIso(),
      }
    }),
  }

  // Materialize themes + highlights as Journey notes/sights
  const materialize: TripIngestDraftItem[] = []
  for (const day of dayPlan) {
    if (day.theme.trim()) {
      materialize.push({
        type: 'note',
        title: day.theme.slice(0, 120),
        place: day.areaLabel,
        city: day.areaLabel,
        date: day.date,
        notes: [
          `Day theme · ${day.areaLabel}`,
          day.why ? `Why: ${day.why}` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 500),
        confidence: 'medium',
        source: 'inferred',
        tentative: true,
      })
    }
    for (const h of day.highlights) {
      const name = typeof h === 'string' ? h : h.name
      const why = typeof h === 'string' ? '' : h.why
      if (!name.trim() || dropped.has(name.toLowerCase())) continue
      materialize.push({
        type: 'sight',
        title: name.slice(0, 120),
        place: name,
        city: day.areaLabel,
        date: day.date,
        notes: [
          `From trip AI · ${day.areaLabel}`,
          why ? `Why: ${why}` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 500),
        confidence: 'medium',
        source: 'inferred',
        tentative: true,
      })
    }
  }

  const existingKeys = new Set(
    next.items
      .filter((i) => !isPlaceholderBase(i))
      .map((i) =>
        transitCorridorKey(i.type, i.date, i.from || '', i.to || '', i.title),
      ),
  )
  const titleDateKeys = new Set(
    next.items
      .filter((i) => !isPlaceholderBase(i))
      .map((i) => `${i.type}|${i.date}|${i.title.toLowerCase()}`),
  )

  const safeItems = [...draft.items, ...materialize].filter((i) => {
    if (i.type.toLowerCase() === 'hotel') return false
    const isTransit = ['flight', 'train', 'bus', 'ferry'].includes(
      i.type.toLowerCase(),
    )
    if (isTransit) {
      const k = transitCorridorKey(
        i.type,
        i.date,
        i.from || '',
        i.to || '',
        i.title,
      )
      if (existingKeys.has(k)) return false
      // Also skip if any existing transit same type+date
      const sameDay = next.items.some(
        (e) =>
          !isPlaceholderBase(e) &&
          e.type === i.type &&
          e.date === i.date,
      )
      if (sameDay) return false
      existingKeys.add(k)
    } else {
      const tk = `${i.type}|${i.date}|${i.title.toLowerCase()}`
      if (titleDateKeys.has(tk)) return false
      titleDateKeys.add(tk)
    }
    return true
  })

  next = applyIngestDraft(next, safeItems, draft.planPlaceNames)
  return { ...next, updatedAt: nowIso() }
}

/**
 * Apply draft then geocode stay-zones, highlights, plan seeds, and transit.
 * Uses Nominatim (via proxy) with city bias — same approach as free OSM planners
 * (WanderPlan / MyTripPlanner): every stop gets `Name, City` lookup, rate-limited.
 */
export async function applyFullTripDraftWithPlaces(
  trip: TripRecord,
  draft: FullTripDraft,
  opts?: { signal?: AbortSignal },
): Promise<TripRecord> {
  await resolvePlaceProvider({ signal: opts?.signal })
  let next = applyFullTripDraft(trip, draft)
  const useGoogle = useGooglePlacesNow()

  const areaQueries = new Map<string, string>()
  for (const d of draft.dayPlan) {
    if (d.areaLabel) areaQueries.set(d.areaLabel.toLowerCase(), d.areaLabel)
  }
  for (const a of draft.spine.areas) {
    areaQueries.set(a.label.toLowerCase(), a.label)
  }

  const areaCoords = new Map<string, { lat: number; lon: number }>()
  for (const [, q] of areaQueries) {
    try {
      const hit = await lookupPlace(q, { useGooglePlaces: useGoogle })
      if (hit && isValidCoord(hit.lat, hit.lon)) {
        areaCoords.set(q.toLowerCase(), { lat: hit.lat, lon: hit.lon })
      }
    } catch {
      /* skip */
    }
  }

  // Pin every Journey stop missing coords (sights, restaurants, bases, notes…)
  const geocodedItems: TripItem[] = []
  for (const it of next.items) {
    if (opts?.signal?.aborted) break

    if (['flight', 'train', 'bus', 'ferry'].includes(it.type)) {
      let updated = { ...it }
      try {
        if (
          (updated.lat == null || updated.lon == null) &&
          (updated.from || updated.place)
        ) {
          const hit = await lookupPlace(updated.from || updated.place, {
            useGooglePlaces: useGoogle,
          })
          if (hit && isValidCoord(hit.lat, hit.lon)) {
            updated = {
              ...updated,
              lat: hit.lat,
              lon: hit.lon,
              osmId: hit.osmId || updated.osmId,
            }
          }
        }
        if ((updated.latTo == null || updated.lonTo == null) && updated.to) {
          const hit = await lookupPlace(updated.to, {
            useGooglePlaces: useGoogle,
          })
          if (hit && isValidCoord(hit.lat, hit.lon)) {
            updated = {
              ...updated,
              latTo: hit.lat,
              lonTo: hit.lon,
            }
          }
        }
      } catch {
        /* keep */
      }
      geocodedItems.push(updated)
      continue
    }

    if (isValidCoord(it.lat, it.lon)) {
      geocodedItems.push(it)
      continue
    }

    const cityKey = (it.city || it.place || '').toLowerCase()
    const areaHit = cityKey ? areaCoords.get(cityKey) : undefined
    const bias = areaHit
      ? { lat: areaHit.lat, lon: areaHit.lon, radiusM: 50_000 }
      : undefined

    // Theme notes / empty place → drop pin on stay-zone center
    const placeName = (it.place || it.title || '').trim()
    const isThemeNote =
      it.type === 'note' &&
      (!placeName || placeName.toLowerCase() === (it.city || '').toLowerCase())

    if (isThemeNote && areaHit) {
      geocodedItems.push({
        ...it,
        lat: areaHit.lat,
        lon: areaHit.lon,
        updatedAt: nowIso(),
      })
      continue
    }

    if (isPlaceholderBase(it) && areaHit) {
      geocodedItems.push({
        ...it,
        lat: areaHit.lat,
        lon: areaHit.lon,
        updatedAt: nowIso(),
      })
      continue
    }

    const query = [placeName, it.city].filter(Boolean).join(', ')
    if (!query) {
      if (areaHit) {
        geocodedItems.push({
          ...it,
          lat: areaHit.lat,
          lon: areaHit.lon,
          updatedAt: nowIso(),
        })
      } else {
        geocodedItems.push(it)
      }
      continue
    }

    try {
      const hit = await lookupPlace(query, {
        useGooglePlaces: useGoogle,
        bias,
      })
      if (hit && isValidCoord(hit.lat, hit.lon)) {
        geocodedItems.push({
          ...it,
          lat: hit.lat,
          lon: hit.lon,
          place: it.place || hit.name || it.place,
          osmId: hit.osmId || it.osmId,
          geocodeQuery: query,
          updatedAt: nowIso(),
        })
      } else if (areaHit) {
        // Fallback: city center so the map still shows the stop
        geocodedItems.push({
          ...it,
          lat: areaHit.lat,
          lon: areaHit.lon,
          updatedAt: nowIso(),
        })
      } else {
        geocodedItems.push(it)
      }
    } catch {
      geocodedItems.push(
        areaHit
          ? { ...it, lat: areaHit.lat, lon: areaHit.lon, updatedAt: nowIso() }
          : it,
      )
    }
  }
  next = { ...next, items: geocodedItems }

  // Geocode plan places missing coords
  const places = next.planPlaces || []
  const geocodedPlaces = []
  for (const p of places) {
    if (p.lat != null && p.lon != null) {
      geocodedPlaces.push(p)
      continue
    }
    const q = [p.name, p.city].filter(Boolean).join(', ')
    if (!q) {
      geocodedPlaces.push(p)
      continue
    }
    const biasCity = p.city ? areaCoords.get(p.city.toLowerCase()) : undefined
    try {
      const hit = await lookupPlace(q, {
        useGooglePlaces: useGoogle,
        bias: biasCity
          ? { lat: biasCity.lat, lon: biasCity.lon, radiusM: 50_000 }
          : undefined,
      })
      if (hit && isValidCoord(hit.lat, hit.lon)) {
        geocodedPlaces.push({ ...p, lat: hit.lat, lon: hit.lon })
      } else {
        geocodedPlaces.push(p)
      }
    } catch {
      geocodedPlaces.push(p)
    }
  }
  next = { ...next, planPlaces: geocodedPlaces, updatedAt: nowIso() }

  return next
}

/** Ask the model for a complete trip skeleton (areas + plan seeds, no hotels). */
export async function composeFullTrip(args: {
  trip: TripRecord
  userMessage: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  await resolvePlaceProvider({ signal: args.signal })
  const days = enumerateDays(args.trip.meta.startDate, args.trip.meta.endDate)
  try {
    const data = await postAgent(
      'trip_compose',
      {
        tripName: args.trip.meta.name,
        vibe: args.trip.meta.vibe,
        startDate: args.trip.meta.startDate,
        endDate: args.trip.meta.endDate,
        dayCount: days.length,
        dates: days,
        prefs: prefsFromMeta(args.trip),
        existingSteps: existingStepsBrief(args.trip),
        userMessage: args.userMessage.slice(0, 2500),
        hardRules: [
          'Cover every date in dayPlan with an area stay-zone.',
          'Never invent hotel names or type:hotel items.',
          'Prefer itemUpdates for existingSteps; never duplicate the same flight leg.',
          'Soft wants → planPlaceNames; concrete named highlights.',
          'Each calendar day needs its own dayPlan theme/why — do not reuse one generic theme across a whole stay-zone.',
          'If the user names a birthday/anniversary/special date, set special:true on that day and put celebration highlights only on that date.',
        ],
      },
      args.signal,
    )
    const o = data as Record<string, unknown>
    if (o.kind === 'need_clarification') {
      return {
        kind: 'need_clarification',
        question: String(
          o.question || 'Which region and vibe should we build around?',
        ),
      }
    }
    const draft = parseFullTripDraft(
      o.kind === 'full_trip' ? o : { ...o, kind: 'full_trip' },
      args.trip,
    )
    if (!draft) {
      return {
        kind: 'need_clarification',
        question:
          'Could not build a spine — try naming a country or region (e.g. South of France).',
      }
    }
    return { kind: 'full_trip', draft }
  } catch (e) {
    return {
      kind: 'need_clarification',
      question:
        e instanceof Error
          ? e.message
          : 'AI unavailable — add a region hint and try again.',
    }
  }
}

/** Apply a spine option as area day-bases + prefs (no hotels). */
export function applySpineToTrip(
  trip: TripRecord,
  spine: TripSpineOption,
): TripRecord {
  return applyFullTripDraft(trip, {
    summary: spine.summary,
    spine,
    dayPlan: allocateSpineToDays(
      trip.meta.startDate,
      trip.meta.endDate,
      spine.areas,
    ),
    planPlaceNames: [],
    items: [],
    openQuestions: spine.openQuestions,
  })
}

export async function requestEnrichment(args: {
  trip: TripRecord
  userMessage?: string
  signal?: AbortSignal
}): Promise<TripPlannerResult> {
  const legs = args.trip.items
    .filter((i) =>
      ['flight', 'train', 'activity', 'sight'].includes(i.type),
    )
    .slice(0, 20)
    .map((i) => ({
      title: i.title,
      type: i.type,
      date: i.date,
      from: i.from,
      to: i.to,
      start: i.start,
      place: i.place,
      city: i.city,
      notes: i.notes.slice(0, 200),
    }))
  try {
    const data = await postAgent(
      'trip_enrich',
      {
        legs,
        areas: prefsFromMeta(args.trip).adoptedAreas || [],
        userMessage: (args.userMessage || 'Find missing details and must-knows').slice(
          0,
          1000,
        ),
        hardRules: [
          'Never invent confirmation codes or prices.',
          'Never invent hotel names.',
          'Caveats at area/country level preferred.',
          'Field updates need confidence + source.',
        ],
      },
      args.signal,
    )
    const o = data as Record<string, unknown>
    const fieldUpdates = Array.isArray(o.fieldUpdates)
      ? o.fieldUpdates
          .map((u) => {
            if (!u || typeof u !== 'object') return null
            const x = u as Record<string, unknown>
            return {
              itemTitle: String(x.itemTitle ?? '').slice(0, 200),
              field: String(x.field ?? '').slice(0, 40),
              value: String(x.value ?? '').slice(0, 300),
              confidence: (['high', 'medium', 'low'].includes(String(x.confidence))
                ? String(x.confidence)
                : 'low') as 'high' | 'medium' | 'low',
              source: (String(x.source) === 'web' ? 'web' : 'model') as
                | 'web'
                | 'model',
              citation: x.citation ? String(x.citation).slice(0, 300) : undefined,
            }
          })
          .filter(Boolean)
      : []
    const caveats: Caveat[] = Array.isArray(o.caveats)
      ? (o.caveats
          .map((c) => {
            if (!c || typeof c !== 'object') return null
            const x = c as Record<string, unknown>
            return {
              severity: (['info', 'warn', 'dealbreaker'].includes(String(x.severity))
                ? String(x.severity)
                : 'info') as Caveat['severity'],
              topic: String(x.topic ?? '').slice(0, 80),
              summary: String(x.summary ?? '').slice(0, 400),
              appliesTo: (['area', 'hotel', 'day', 'leg', 'trip'].includes(
                String(x.appliesTo),
              )
                ? String(x.appliesTo)
                : 'area') as Caveat['appliesTo'],
              source: (String(x.source) === 'web' ? 'web' : 'model') as
                | 'web'
                | 'model',
            }
          })
          .filter(Boolean) as Caveat[])
      : []
    return {
      kind: 'enrich',
      fieldUpdates: fieldUpdates as Extract<
        TripPlannerResult,
        { kind: 'enrich' }
      >['fieldUpdates'],
      caveats,
    }
  } catch {
    return { kind: 'enrich', fieldUpdates: [], caveats: [] }
  }
}

/** Neighborhood hotel-search zones + vibe fit so the traveler feels ready. */
export async function requestAreaKnowHow(args: {
  trip: TripRecord
  areas?: string[]
  draft?: FullTripDraft | null
  userMessage?: string
  signal?: AbortSignal
}): Promise<Extract<TripPlannerResult, { kind: 'area_knowhow' }>> {
  const fromDraft =
    args.draft?.spine?.areas?.map((a) => a.label).filter(Boolean) || []
  const fromDay =
    args.draft?.dayPlan?.map((d) => d.areaLabel).filter(Boolean) || []
  const fromPrefs = prefsFromMeta(args.trip).adoptedAreas || []
  const fromCities = args.trip.items
    .map((i) => i.city || i.place)
    .filter(Boolean)
  const areas = [
    ...(args.areas || []),
    ...fromDraft,
    ...fromDay,
    ...fromPrefs,
    ...fromCities,
  ]
    .map((a) => String(a).trim())
    .filter(Boolean)
  const unique: string[] = []
  const seen = new Set<string>()
  for (const a of areas) {
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(a.slice(0, 80))
    if (unique.length >= 8) break
  }
  if (!unique.length) {
    return {
      kind: 'area_knowhow',
      summary:
        'Add a route or stay zones first — then I can brief hotel-search neighborhoods for each area.',
      areas: [],
    }
  }
  try {
    const data = await postAgent(
      'trip_area_knowhow',
      {
        areas: unique,
        vibe: args.trip.meta.vibe || [],
        prefs: prefsFromMeta(args.trip),
        dates: {
          start: args.trip.meta.startDate,
          end: args.trip.meta.endDate,
        },
        dayThemes: (args.draft?.dayPlan || [])
          .filter((d) => d.special || d.theme)
          .slice(0, 12)
          .map((d) => ({
            date: d.date,
            areaLabel: d.areaLabel,
            theme: d.theme,
            special: Boolean(d.special),
          })),
        userMessage: (
          args.userMessage ||
          'Brief hotel-search neighborhoods and vibe fit so I feel ready to book lodging'
        ).slice(0, 1000),
        hardRules: [
          'Never invent hotel brand names.',
          'Zones = neighborhoods / districts only.',
          'Match forVibes to the traveler when possible.',
        ],
      },
      args.signal,
    )
    const o = data as Record<string, unknown>
    const areasOut: AreaKnowHow[] = []
    if (Array.isArray(o.areas)) {
      for (const raw of o.areas) {
        if (!raw || typeof raw !== 'object') continue
        const x = raw as Record<string, unknown>
        const hotelZones: AreaKnowHow['hotelZones'] = []
        if (Array.isArray(x.hotelZones)) {
          for (const z of x.hotelZones) {
            if (!z || typeof z !== 'object') continue
            const zz = z as Record<string, unknown>
            const label = String(zz.label ?? '').slice(0, 80)
            const why = String(zz.why ?? '').slice(0, 280)
            if (!label || !why) continue
            hotelZones.push({
              label,
              why,
              forVibes: Array.isArray(zz.forVibes)
                ? zz.forVibes.map((t) => String(t).slice(0, 40)).slice(0, 6)
                : [],
            })
            if (hotelZones.length >= 4) break
          }
        }
        const readyTips = Array.isArray(x.readyTips)
          ? x.readyTips
              .map((t) => String(t).slice(0, 200))
              .filter(Boolean)
              .slice(0, 6)
          : []
        const areaLabel = String(x.areaLabel ?? '').slice(0, 80)
        const vibeFit = String(x.vibeFit ?? '').slice(0, 400)
        if (!areaLabel || !vibeFit) continue
        const entry: AreaKnowHow = {
          areaLabel,
          vibeFit,
          hotelZones,
          readyTips,
        }
        if (x.tradeoffs) entry.tradeoffs = String(x.tradeoffs).slice(0, 320)
        areasOut.push(entry)
        if (areasOut.length >= 8) break
      }
    }
    return {
      kind: 'area_knowhow',
      summary: String(
        o.summary ||
          (areasOut.length
            ? 'Neighborhood bases and vibe notes so you can search lodging with confidence.'
            : 'Could not build area know-how this round.'),
      ).slice(0, 400),
      areas: areasOut,
    }
  } catch {
    return {
      kind: 'area_knowhow',
      summary: 'Could not load area know-how — try again in a moment.',
      areas: [],
    }
  }
}

/** Seed Discover lists from nearby explore for an area (Plan Discover AI). */
export async function suggestDiscoverForAnchor(args: {
  trip: TripRecord
  lat: number
  lon: number
  signal?: AbortSignal
}): Promise<{ trip: TripRecord; added: number; provider: string }> {
  await resolvePlaceProvider({ signal: args.signal })
  let places: ExplorePlace[] = []
  try {
    places = await fetchNearbyExplore(
      { lat: args.lat, lon: args.lon },
      {
        categories: ['sights', 'food', 'nature', 'activity'],
        radiusM: 3000,
        limit: 20,
        useGooglePlaces: useGooglePlacesNow(),
      },
    )
  } catch (e) {
    markPlacesUnhealthy(e instanceof Error ? e.message : String(e))
    places = await fetchNearbyExplore(
      { lat: args.lat, lon: args.lon },
      {
        categories: ['sights', 'food', 'nature', 'activity'],
        radiusM: 3000,
        limit: 20,
        useGooglePlaces: false,
      },
    )
  }
  let trip = ensurePlanScaffold(args.trip)
  let added = 0
  const existing = new Set(
    (trip.planPlaces || []).map((p) => p.name.toLowerCase()),
  )
  for (const place of places) {
    if (place.category === 'hotel') continue
    if (existing.has(place.name.toLowerCase())) continue
    const section =
      planSectionForExploreCategory(trip, place.category) ||
      planMaybeSection(trip)
    if (!section) continue
    trip = addPlanPlace(trip, {
      sectionId: section.id,
      name: place.name,
      place: place.address || place.name,
      notes: `Discover AI (${useGooglePlacesNow() ? 'Google' : 'OSM'})`,
      lat: place.lat,
      lon: place.lon,
      url: place.website || '',
      osmId: place.osmId || '',
      enrichmentSummary: place.summary || '',
      enrichmentImage: place.images[0] || '',
      images: place.images.slice(0, 6),
      openingHours: place.openingHours || '',
      openingPeriods: place.openingPeriods || [],
      rating: place.rating,
      cuisine: place.cuisine || '',
    })
    existing.add(place.name.toLowerCase())
    added++
    if (added >= 12) break
  }
  return {
    trip: { ...trip, updatedAt: nowIso() },
    added,
    provider: useGooglePlacesNow() ? 'google' : 'osm',
  }
}
