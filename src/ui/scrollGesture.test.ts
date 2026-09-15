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
  it('keeps Day Coach under ~55vh so phones are not mostly sheet', () => {
    expect(MOBILE_SHEET_HEIGHT.aiCoach).toMatch(/52vh/)
    expect(MOBILE_SHEET_HEIGHT.aiCoach).not.toMatch(/68vh|75vh|90vh/)
  })

  it('keeps option detail under 90%', () => {
    expect(MOBILE_SHEET_HEIGHT.aiCoachDetail).toMatch(/70vh/)
    expect(MOBILE_SHEET_HEIGHT.aiCoachDetail).not.toMatch(/90%/)
  })

  it('keeps normal Steps strip modest', () => {
    expect(MOBILE_SHEET_HEIGHT.steps).toMatch(/38vh/)
  })
})
