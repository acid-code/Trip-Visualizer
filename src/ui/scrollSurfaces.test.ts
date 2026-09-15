/**
 * Regression guards for phone scroll surfaces.
 * If a sheet stops scrolling or steals taps again, these fail in CI / `npm test`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertTouchScrollClass } from './scrollGesture'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('scroll surface source contracts', () => {
  it('FilterMenu uses tap-tracker (not preventDefault on pointerdown pick)', () => {
    const src = readSrc('src/ui/TimelinePanel.tsx')
    expect(src).toContain('createTapTracker')
    expect(src).toContain('data-scrollable="filter-menu"')
    expect(src).toContain('TOUCH_SCROLL_Y')
    // Old bug: selecting on pointerdown + preventDefault blocked scroll
    expect(src).not.toMatch(/onPointerDown=\{\(e\) => \{\s*\/\/ Apply on pointerdown/)
    expect(src).not.toMatch(/e\.preventDefault\(\)\s*\n\s*e\.stopPropagation\(\)\s*\n\s*pick\(/)
  })

  it('Type filter uses the pretty grid variant', () => {
    const src = readSrc('src/ui/TimelinePanel.tsx')
    expect(src).toContain('variant="type-grid"')
  })

  it('phone Steps rail has horizontal touch pan', () => {
    const src = readSrc('src/ui/TimelinePanel.tsx')
    const rail = src.match(/step-rail-h[^`]+/)?.[0] ?? ''
    expect(assertTouchScrollClass(rail, 'x')).toEqual([])
  })

  it('App mobile sheets use shared height tokens', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toContain('MOBILE_SHEET_HEIGHT.aiCoach')
    expect(src).toContain('MOBILE_SHEET_HEIGHT.steps')
    expect(src).toContain('MOBILE_SHEET_HEIGHT.aiReviewSteps')
    expect(src).not.toContain('h-[min(68vh,30rem)]')
  })

  it('AiCoach detail uses capped height token', () => {
    const src = readSrc('src/ui/AiCoachSheet.tsx')
    expect(src).toContain('MOBILE_SHEET_HEIGHT.aiCoachDetail')
    expect(src).not.toContain('max-h-[90%]')
  })

  it('Explore horizontal list keeps touch-pan-x', () => {
    const src = readSrc('src/ui/ExploreSheet.tsx')
    expect(src).toContain('touch-pan-x')
    expect(src).toContain('overscroll-x-contain')
  })

  it('Charts / Data phone panes keep touch-pan-y', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toMatch(/navTab === 'charts'[\s\S]{0,500}touch-pan-y/)
    expect(src).toMatch(/navTab === 'settings'[\s\S]{0,500}touch-pan-y/)
  })
})
