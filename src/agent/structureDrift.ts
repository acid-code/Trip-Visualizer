/**
 * Detect when the live Journey diverged from the last trip structure sketch.
 * Mild edits → auto-sync the draft. Weird / obstructive → ask clarifying questions.
 */

import type { TripItem, TripRecord } from '../domain/types'
import { enumerateDays, isPlaceholderBase } from '../data/dayBases'
import { allocateSpineToDays } from './tripPlanner'
import type { FullTripDayPlan, FullTripDraft } from './types'

export type StructureDriftResult =
  | { kind: 'none' }
  | {
      kind: 'auto'
      draft: FullTripDraft
      summary: string
    }
  | {
      kind: 'ask'
      questions: string[]
      summary: string
    }

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+base$/i, '')
    .replace(/\s+stay-?zone$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function areasRelated(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  return na.includes(nb) || nb.includes(na)
}

function liveTransit(trip: TripRecord): TripItem[] {
  return trip.items.filter(
    (i) =>
      !isPlaceholderBase(i) &&
      ['flight', 'train', 'bus', 'ferry'].includes(i.type) &&
      i.status !== 'cancelled',
  )
}

function transitKey(i: {
  type: string
  date: string
  from?: string
  to?: string
  title?: string
}): string {
  const corridor =
    i.from && i.to
      ? `${norm(i.from)}>${norm(i.to)}`
      : norm(i.title || '')
  return `${i.type}|${i.date}|${corridor}`
}

/** Day → area label from placeholder / day-base shells on the Journey. */
export function liveDayAreas(trip: TripRecord): Map<string, string> {
  const map = new Map<string, string>()
  for (const it of trip.items) {
    if (!isPlaceholderBase(it) && !it.tags?.includes('day-base')) continue
    let label = (it.city || it.place || '').trim()
    if (!label) {
      label = it.title.replace(/\s+base$/i, '').trim()
    }
    if (!label || /^day\s*\d+$/i.test(label)) continue
    map.set(it.date, label)
  }
  return map
}

export function draftDayAreas(draft: FullTripDraft): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of draft.dayPlan) {
    if (d.areaLabel.trim()) map.set(d.date, d.areaLabel.trim())
  }
  return map
}

/** Compact fingerprint of structure-relevant live trip state. */
export function fingerprintLiveTrip(trip: TripRecord): string {
  const days = [...liveDayAreas(trip).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, a]) => `${d}:${norm(a)}`)
    .join(',')
  const transit = liveTransit(trip)
    .map(transitKey)
    .sort()
    .join(';')
  return [
    trip.meta.startDate,
    trip.meta.endDate,
    days,
    transit,
  ].join('|')
}

export function fingerprintDraft(draft: FullTripDraft): string {
  const days = [...draftDayAreas(draft).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, a]) => `${d}:${norm(a)}`)
    .join(',')
  const spine = draft.spine.areas.map((a) => norm(a.label)).join('>')
  return `${spine}|${days}`
}

function dayPlanCoverage(draft: FullTripDraft): {
  start: string
  end: string
} | null {
  if (!draft.dayPlan.length) return null
  const dates = draft.dayPlan.map((d) => d.date).sort()
  return { start: dates[0]!, end: dates[dates.length - 1]! }
}

function daysDelta(a: string, b: string): number {
  const ta = Date.parse(`${a}T12:00:00`)
  const tb = Date.parse(`${b}T12:00:00`)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 99
  return Math.round((tb - ta) / 86_400_000)
}

function byAreaTheme(draft: FullTripDraft): Map<
  string,
  { theme: string; why?: string; highlights: FullTripDayPlan['highlights'] }
> {
  const map = new Map<
    string,
    { theme: string; why?: string; highlights: FullTripDayPlan['highlights'] }
  >()
  for (const d of draft.dayPlan) {
    const key = norm(d.areaLabel)
    if (!key || map.has(key)) continue
    map.set(key, {
      theme: d.theme,
      why: d.why,
      highlights: d.highlights,
    })
  }
  return map
}

function mergeThemesOnto(
  dayPlan: FullTripDayPlan[],
  draft: FullTripDraft,
): FullTripDayPlan[] {
  const themes = byAreaTheme(draft)
  return dayPlan.map((d) => {
    const hit = themes.get(norm(d.areaLabel))
    if (!hit) return d
    return {
      ...d,
      theme: hit.theme || d.theme,
      why: hit.why || d.why,
      highlights: hit.highlights.length ? hit.highlights : d.highlights,
    }
  })
}

/**
 * Compare draft structure to the live Journey.
 * Returns auto-synced draft, clarifying questions, or none.
 */
export function reconcileStructureDrift(
  draft: FullTripDraft,
  trip: TripRecord,
): StructureDriftResult {
  if (!draft.dayPlan.length && !draft.spine.areas.length) {
    return { kind: 'none' }
  }

  const live = liveDayAreas(trip)
  const draftAreas = draftDayAreas(draft)
  const coverage = dayPlanCoverage(draft)
  const tripDays = enumerateDays(trip.meta.startDate, trip.meta.endDate)
  const questions: string[] = []
  const mildNotes: string[] = []

  // Date-range shift
  let dateShiftWeird = false
  if (coverage && tripDays.length) {
    const startShift = Math.abs(daysDelta(coverage.start, trip.meta.startDate))
    const endShift = Math.abs(daysDelta(coverage.end, trip.meta.endDate))
    const lenDiff = Math.abs(tripDays.length - draft.dayPlan.length)
    if (startShift > 2 || endShift > 2 || lenDiff > 2) {
      dateShiftWeird = true
      questions.push(
        `Your trip dates are now ${trip.meta.startDate} → ${trip.meta.endDate}, but the sketch still covers ${coverage.start} → ${coverage.end} (${draft.dayPlan.length} days). Keep the same stay-zone order and stretch/shrink it, or rebuild the route?`,
      )
    } else if (startShift > 0 || endShift > 0 || lenDiff > 0) {
      mildNotes.push('aligned stay-zone days to your trip dates')
    }
  }

  // Live day shells vs draft areas
  const foreignCities: Array<{ date: string; live: string; draft: string }> =
    []
  const remaps: Array<{ date: string; from: string; to: string }> = []

  for (const [date, liveLabel] of live) {
    const drafted = draftAreas.get(date)
    if (!drafted) continue
    if (areasRelated(liveLabel, drafted)) continue
    const matchesSpine = draft.spine.areas.some((a) =>
      areasRelated(liveLabel, a.label),
    )
    if (matchesSpine) {
      remaps.push({ date, from: drafted, to: liveLabel })
    } else {
      foreignCities.push({ date, live: liveLabel, draft: drafted })
    }
  }

  if (foreignCities.length >= 2 || (foreignCities.length === 1 && dateShiftWeird)) {
    for (const f of foreignCities.slice(0, 3)) {
      questions.push(
        `On ${f.date} your Journey shows “${f.live}”, but the sketch still has “${f.draft}”. Keep “${f.live}”, go back to “${f.draft}”, or treat this as a new stay-zone?`,
      )
    }
  } else if (foreignCities.length === 1) {
    const f = foreignCities[0]!
    // Single city rename outside spine — ask once (could be intentional)
    questions.push(
      `On ${f.date} you moved the day shell to “${f.live}” (sketch had “${f.draft}”). Should I rebuild the structure around “${f.live}”, or was that just a pin tweak?`,
    )
  }

  // Transit destinations that imply a new hub outside the spine
  const spineNorm = draft.spine.areas.map((a) => a.label)
  const transit = liveTransit(trip)
  const exoticHubs = new Set<string>()
  for (const t of transit) {
    for (const raw of [t.from, t.to, t.city, t.place]) {
      if (!raw || raw.length < 3) continue
      // Skip airport codes / short tokens
      if (/^[A-Z]{3}$/.test(raw.trim())) continue
      const related = spineNorm.some((a) => areasRelated(raw, a))
      if (!related && norm(raw).length >= 4) {
        // Only flag city-like tokens that appear as place/city on transit
        if (raw === t.city || raw === t.place) exoticHubs.add(raw.trim())
      }
    }
  }
  if (exoticHubs.size && !questions.length) {
    const sample = [...exoticHubs].slice(0, 2).join(', ')
    questions.push(
      `Your Journey now mentions ${sample}, which isn’t in the sketched route (${spineNorm.join(' → ') || '—'}). Fold that into the structure, or leave the sketch as-is?`,
    )
  }

  if (questions.length) {
    const n = Math.min(questions.length, 4)
    const summary =
      n === 1
        ? 'Your Journey changed since this sketch — one choice before I update the structure.'
        : n === 2
          ? 'Your Journey changed since this sketch — a couple of choices before I update the structure.'
          : `Your Journey changed since this sketch — ${n} choices before I update the structure.`
    return {
      kind: 'ask',
      questions: questions.slice(0, 4),
      summary,
    }
  }

  // Auto path: remap + realign dates
  let nextPlan = [...draft.dayPlan]
  let changed = false

  if (mildNotes.length || remaps.length) {
    if (
      coverage &&
      (coverage.start !== trip.meta.startDate ||
        coverage.end !== trip.meta.endDate ||
        draft.dayPlan.length !== tripDays.length) &&
      draft.spine.areas.length
    ) {
      nextPlan = mergeThemesOnto(
        allocateSpineToDays(
          trip.meta.startDate,
          trip.meta.endDate,
          draft.spine.areas,
        ),
        draft,
      )
      changed = true
    }
  }

  if (remaps.length) {
    const remapByDate = new Map(remaps.map((r) => [r.date, r.to]))
    nextPlan = nextPlan.map((d) => {
      const to = remapByDate.get(d.date)
      if (!to) return d
      changed = true
      return { ...d, areaLabel: to }
    })
    mildNotes.push(
      `matched ${remaps.length} day shell${remaps.length === 1 ? '' : 's'} you edited`,
    )
  }

  // Apply live labels when related (normalize casing / "Nice base" → Nice)
  for (const [date, liveLabel] of live) {
    const idx = nextPlan.findIndex((d) => d.date === date)
    if (idx < 0) continue
    const cur = nextPlan[idx]!
    if (areasRelated(liveLabel, cur.areaLabel) && liveLabel !== cur.areaLabel) {
      // Prefer shorter city-like label from Journey when clearly related
      if (liveLabel.length <= cur.areaLabel.length + 4) {
        nextPlan[idx] = { ...cur, areaLabel: liveLabel }
        changed = true
      }
    }
  }

  if (!changed) return { kind: 'none' }

  const nextDraft: FullTripDraft = {
    ...draft,
    dayPlan: nextPlan,
    decisions: [
      ...(draft.decisions || []),
      {
        what: 'Synced sketch to Journey edits',
        why: mildNotes.join('; ') || 'Matched your latest trip changes.',
      },
    ].slice(0, 16),
  }

  return {
    kind: 'auto',
    draft: nextDraft,
    summary:
      mildNotes.length > 0
        ? `Updated the structure to match your Journey (${mildNotes.join('; ')}).`
        : 'Updated the structure to match your Journey.',
  }
}
