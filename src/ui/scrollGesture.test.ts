import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertTouchScrollClass,
  createTapTracker,
  MOBILE_SHEET_HEIGHT,
  TAP_MOVE_THRESHOLD_PX,
  TOUCH_SCROLL_X,
  TOUCH_SCROLL_Y,
} from './scrollGesture'

describe('createTapTracker', () => {
  it('counts a still pointer as a tap', () => {
    const tap = createTapTracker()
    tap.onPointerDown({ clientX: 40, clientY: 100 })
    tap.onPointerMove({ clientX: 42, clientY: 101 })
    expect(tap.onPointerUp()).toBe(true)
  })

  it('rejects vertical scrolls past the threshold', () => {
    const tap = createTapTracker()
    tap.onPointerDown({ clientX: 40, clientY: 100 })
    tap.onPointerMove({ clientX: 40, clientY: 100 + TAP_MOVE_THRESHOLD_PX + 1 })
    expect(tap.hasMoved()).toBe(true)
    expect(tap.onPointerUp()).toBe(false)
  })

  it('rejects horizontal scrolls past the threshold', () => {
    const tap = createTapTracker()
    tap.onPointerDown({ clientX: 10, clientY: 50 })
    tap.onPointerMove({ clientX: 10 + TAP_MOVE_THRESHOLD_PX + 2, clientY: 50 })
    expect(tap.onPointerUp()).toBe(false)
  })

  it('cancels mid-gesture', () => {
    const tap = createTapTracker()
    tap.onPointerDown({ clientX: 0, clientY: 0 })
    tap.onPointerCancel()
    expect(tap.onPointerUp()).toBe(false)
  })
})

describe('touch scroll class helpers', () => {
  it('TOUCH_SCROLL_Y includes pan + overscroll tokens', () => {
    expect(assertTouchScrollClass(TOUCH_SCROLL_Y, 'y')).toEqual([])
  })

  it('TOUCH_SCROLL_X includes pan + overscroll tokens', () => {
    expect(assertTouchScrollClass(TOUCH_SCROLL_X, 'x')).toEqual([])
  })

  it('flags missing tokens', () => {
    expect(assertTouchScrollClass('overflow-y-auto', 'y')).toContain('touch-pan-y')
  })
})

describe('MOBILE_SHEET_HEIGHT', () => {
  it('uses shared CSS sheet classes (dvh tokens live in index.css)', () => {
    expect(MOBILE_SHEET_HEIGHT.aiCoach).toBe('sheet-h-ai')
    expect(MOBILE_SHEET_HEIGHT.aiCoachDetail).toBe('sheet-h-ai-detail')
    expect(MOBILE_SHEET_HEIGHT.steps).toBe('sheet-h-steps')
    expect(MOBILE_SHEET_HEIGHT.aiReviewSteps).toBe('sheet-h-ai-review')
    expect(MOBILE_SHEET_HEIGHT.explore).toBe('sheet-h-explore')
    expect(MOBILE_SHEET_HEIGHT.exploreDetail).toBe('sheet-h-explore-detail')
    expect(MOBILE_SHEET_HEIGHT.tall).toBe('sheet-h-tall')
  })

  it('index.css keeps Day Coach under ~55dvh so phones are not mostly sheet', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'),
      'utf8',
    )
    expect(css).toMatch(/--sheet-ai:\s*min\(52(?:d)?vh,\s*24rem\)/)
    expect(css).not.toMatch(/--sheet-ai:\s*min\((?:68|75|90)(?:d)?vh/)
    expect(css).toMatch(/--sheet-ai-detail:\s*min\(70(?:d)?vh,\s*28rem\)/)
    expect(css).toMatch(/--sheet-steps-soft:\s*min\(38(?:d)?vh/)
    expect(css).toMatch(/--sheet-ai-review:\s*min\(30(?:d)?vh,\s*13rem\)/)
  })
})
