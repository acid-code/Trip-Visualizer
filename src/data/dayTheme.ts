import type { TripMeta } from '../domain/types'
import { dayIndex } from './analytics'

/** Distinct day palette — cycles for long trips */
export const DAY_COLORS = [
  '#ff6b4a', // coral
  '#0d9488', // teal
  '#3b82f6', // blue
  '#a855f7', // purple
  '#eab308', // yellow
  '#ec4899', // pink
  '#14b8a6', // aqua
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
] as const

export function dayColor(meta: TripMeta, date: string): string {
  const idx = Math.max(0, dayIndex(meta, date) - 1)
  return DAY_COLORS[idx % DAY_COLORS.length]
}

export function dayColorByIndex(dayNumber: number): string {
  const idx = Math.max(0, dayNumber - 1)
  return DAY_COLORS[idx % DAY_COLORS.length]
}
