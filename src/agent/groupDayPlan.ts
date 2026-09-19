/**
 * Stay-zone grouping that keeps per-day themes/highlights visible.
 * Consecutive same areaLabel → one stay zone, but days are NOT collapsed away.
 */

import type { FullTripDayPlan, FullTripDraft, FullTripHighlight } from './types'

export type StayZoneDay = {
  date: string
  theme: string
  why?: string
  highlights: FullTripHighlight[]
  /** Birthday / anniversary / named celebration — call out in the tree. */
  special: boolean
}

export type StayZoneGroup = {
  areaLabel: string
  start: string
  end: string
  days: StayZoneDay[]
}

const SPECIAL_RE =
  /\b(birthday|anniversary|celebration|special day|honeymoon|proposal|wedding|milestone|surprise)\b/i

export function isSpecialDayTheme(theme: string, why?: string): boolean {
  return SPECIAL_RE.test(`${theme} ${why || ''}`)
}

function asHighlight(h: FullTripHighlight | string): FullTripHighlight {
  return typeof h === 'string' ? { name: h, why: '' } : h
}

function toStayDay(d: FullTripDayPlan): StayZoneDay {
  const special = Boolean(
    d.special || isSpecialDayTheme(d.theme, d.why),
  )
  return {
    date: d.date,
    theme: d.theme,
    why: d.why,
    highlights: (d.highlights || []).map(asHighlight),
    special,
  }
}

/**
 * Group consecutive dayPlan rows that share an areaLabel into stay zones,
 * preserving every calendar day (theme, why, highlights) inside the zone.
 */
export function groupDayPlan(draft: FullTripDraft): StayZoneGroup[] {
  const groups: StayZoneGroup[] = []
  for (const d of draft.dayPlan) {
    if (!d.date || !d.areaLabel) continue
    const day = toStayDay(d)
    const last = groups[groups.length - 1]
    if (last && last.areaLabel === d.areaLabel) {
      last.end = d.date
      last.days.push(day)
    } else {
      groups.push({
        areaLabel: d.areaLabel,
        start: d.date,
        end: d.date,
        days: [day],
      })
    }
  }
  return groups
}
