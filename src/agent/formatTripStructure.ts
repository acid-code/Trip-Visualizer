/**
 * Plain-text trip structure for clipboard copy.
 * Stay zones keep per-day themes so special dates stay visible.
 */

import type { TripRecord } from '../domain/types'
import { isPlaceholderBase } from '../data/dayBases'
import { groupDayPlan } from './groupDayPlan'
import type { FullTripDraft, FullTripHighlight } from './types'

function hlName(h: FullTripHighlight | string): string {
  return typeof h === 'string' ? h : h.name
}

function hlWhy(h: FullTripHighlight | string): string {
  return typeof h === 'string' ? '' : h.why
}

/** Locale-friendly short timestamp for structure headers. */
export function formatStructureTime(at: number): string {
  if (!at || !Number.isFinite(at)) return ''
  try {
    return new Date(at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** "Sep 20, 2026, 01:45 · Asaf" when shared attribution is present. */
export function formatSketchStamp(
  at: number,
  byLabel?: string | null,
): string {
  const when = formatStructureTime(at)
  if (!when) return ''
  const who = String(byLabel || '').trim()
  return who ? `${when} · ${who}` : when
}

/** Prefer display name, else email local-part, else email. */
export function sketchAuthorLabel(user: {
  displayName?: string
  email?: string
}): string {
  const name = String(user.displayName || '').trim()
  if (name) return name.slice(0, 80)
  const email = String(user.email || '').trim()
  if (!email) return ''
  const local = email.split('@')[0] || email
  return local.slice(0, 80)
}

/** Copyable trip plan from the shape tree (draft + live transit). */
export function formatTripStructureText(
  draft: FullTripDraft | null,
  trip: TripRecord,
  opts?: { sketchedAt?: number; sketchedBy?: string },
): string {
  const lines: string[] = []
  const title =
    draft?.spine.label || trip.meta.name || 'Trip structure'
  const when = opts?.sketchedAt
    ? formatSketchStamp(opts.sketchedAt, opts.sketchedBy)
    : ''
  lines.push(when ? `${title} · sketched ${when}` : title)
  if (trip.meta.startDate && trip.meta.endDate) {
    lines.push(`${trip.meta.startDate} → ${trip.meta.endDate}`)
  }
  if (draft?.summary) lines.push('', draft.summary)
  if (draft?.spine.why) lines.push('', `Why this route: ${draft.spine.why}`)

  const existing = trip.items.filter(
    (i) =>
      !isPlaceholderBase(i) &&
      ['flight', 'train', 'bus', 'ferry'].includes(i.type) &&
      i.status !== 'cancelled',
  )
  if (existing.length) {
    lines.push('', 'Already on Journey:')
    for (const f of existing) {
      const corridor =
        f.from && f.to ? `${f.from}→${f.to}` : f.title
      const times =
        f.start || f.end ? ` ${f.start || '??'}–${f.end || '??'}` : ''
      lines.push(`- ${f.date} ${f.type} ${corridor}${times}`)
    }
  }

  if (draft) {
    const dropped = new Set(
      (draft.droppedHighlights || []).map((h) => h.toLowerCase()),
    )
    const groups = groupDayPlan(draft)
    if (groups.length) {
      lines.push('', 'Stay zones:')
      for (const g of groups) {
        const range =
          g.end !== g.start ? `${g.start}–${g.end}` : g.start
        const specialMark = g.days.some((d) => d.special)
          ? ' ★'
          : ''
        lines.push(
          `- ${range} · ${g.areaLabel} stay-zone${specialMark}`,
        )
        for (const day of g.days) {
          const star = day.special ? '★ ' : ''
          const theme = day.theme ? ` · ${day.theme}` : ''
          lines.push(`  ${star}${day.date}${theme}`)
          if (day.why) lines.push(`    Why: ${day.why}`)
          for (const h of day.highlights) {
            const name = hlName(h)
            if (dropped.has(name.toLowerCase())) continue
            const why = hlWhy(h)
            lines.push(
              why ? `    · ${name} — ${why}` : `    · ${name}`,
            )
          }
        }
      }
    }

    const decisions = draft.decisions?.filter((d) => d.what && d.why) || []
    if (decisions.length) {
      lines.push('', 'Why we chose this:')
      for (const d of decisions) {
        lines.push(`- ${d.what}: ${d.why}`)
      }
    }

    const seeds = draft.planPlaceNames || []
    if (seeds.length) {
      lines.push('', `Plan seeds (${seeds.length}):`)
      for (const p of seeds.slice(0, 12)) {
        lines.push(p.why ? `- ${p.name} — ${p.why}` : `- ${p.name}`)
      }
    }
  }

  return lines.join('\n').trim()
}
