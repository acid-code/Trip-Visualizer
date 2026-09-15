/**
 * Regression guards for phone scroll surfaces + dual-mode redesign contracts.
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

  it('App journey book dock uses pull sheet height classes', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toContain('JourneyBookDock')
    expect(src).toContain('book-pages-ai')
    expect(src).toContain('book-pages-steps')
    expect(src).toContain('book-pages-ai-review')
    expect(readSrc('src/index.css')).toContain('book-volume-open')
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

  it('Charts / Settings phone panes keep touch-pan-y', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toMatch(/navTab === 'charts'[\s\S]{0,500}touch-pan-y/)
    expect(src).toMatch(/navTab === 'settings'[\s\S]{0,500}touch-pan-y/)
  })

  it('App exposes Journey|Plan mode switch', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toContain("id: 'journey'")
    expect(src).toContain("id: 'plan'")
    expect(src).toContain('PlanBoard')
    expect(src).toContain('MapLayersControl')
  })

  it('Settings includes cream/dark color mode', () => {
    const src = readSrc('src/App.tsx')
    expect(src).toContain("label: 'Cream'")
    expect(src).toContain("label: 'Dark'")
    expect(src).toContain('colorMode')
    expect(readSrc('src/index.css')).toContain('[data-theme="light"]')
  })

  it('Plan map and board exist', () => {
    expect(readSrc('src/ui/PlanBoard.tsx')).toContain('export function PlanBoard')
    expect(readSrc('src/map/PlanMapView.tsx')).toContain('maplibregl')
    expect(readSrc('src/data/planBoard.ts')).toContain('promotePlanPlaceToStep')
    expect(readSrc('src/data/regionPacks.ts')).toContain('REGION_PACKS')
  })

  it('Modern map look uses esri-dark stack', () => {
    const src = readSrc('src/globe/viewer.ts')
    expect(src).toContain('esri-dark')
    expect(src).toContain('resolveMapStack')
    expect(src).toContain('MapLook')
    expect(src).not.toContain('basemaps.cartocdn.com')
  })

  it('Plan board reconciles journey steps into day buckets', () => {
    expect(readSrc('src/data/planBoard.ts')).toContain('reconcileJourneyAndPlan')
    expect(readSrc('src/data/planBoard.ts')).toContain('JOURNEY_SECTION_TITLE')
  })
})
