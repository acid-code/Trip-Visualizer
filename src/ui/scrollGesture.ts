/** Pixel movement beyond this counts as a scroll/drag, not a tap. */
export const TAP_MOVE_THRESHOLD_PX = 10

/**
 * Distinguishes a tap from a scroll on touch devices.
 * Use on pointerdown/move/up — only treat pointerup as a click when movement
 * stayed within the threshold (so overflow menus can scroll without selecting).
 */
export function createTapTracker(thresholdPx = TAP_MOVE_THRESHOLD_PX) {
  let startX = 0
  let startY = 0
  let tracking = false
  let moved = false

  return {
    onPointerDown(e: { clientX: number; clientY: number }) {
      tracking = true
      moved = false
      startX = e.clientX
      startY = e.clientY
    },
    onPointerMove(e: { clientX: number; clientY: number }) {
      if (!tracking || moved) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (dx * dx + dy * dy > thresholdPx * thresholdPx) moved = true
    },
    /** @returns true when the gesture should count as a tap */
    onPointerUp(): boolean {
      const isTap = tracking && !moved
      tracking = false
      return isTap
    },
    onPointerCancel() {
      tracking = false
      moved = false
    },
    /** Whether the current gesture has already exceeded the move threshold. */
    hasMoved(): boolean {
      return moved
    },
  }
}

/** Shared phone sheet height tokens — keep UI + tests in sync. */
export const MOBILE_SHEET_HEIGHT = {
  /** Day Coach chat / options */
  aiCoach: 'h-[min(52vh,24rem)]',
  /** Day Coach option detail overlay */
  aiCoachDetail: 'max-h-[min(70vh,28rem)]',
  /** Steps strip while browsing */
  steps: 'max-h-[38vh]',
  /** Steps while reviewing an AI draft — keep short so Save/Discard stay clear on phones */
  aiReviewSteps: 'h-[min(30vh,13rem)]',
  /** Explore list */
  explore: 'h-[min(41vh,18.5rem)]',
  /** Explore place detail */
  exploreDetail: 'h-[min(62vh,26.5rem)]',
  /** Stats / Data */
  tall: 'h-[min(72vh,32rem)]',
} as const

/** CSS classes every vertical touch scroller in sheets should include. */
export const TOUCH_SCROLL_Y =
  'overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]' as const

export const TOUCH_SCROLL_X =
  'overflow-x-auto overscroll-x-contain touch-pan-x [-webkit-overflow-scrolling:touch]' as const

export function assertTouchScrollClass(
  className: string,
  axis: 'x' | 'y' = 'y',
): string[] {
  const missing: string[] = []
  const need =
    axis === 'y'
      ? ['overflow-y-auto', 'overscroll-contain', 'touch-pan-y']
      : ['overflow-x-auto', 'overscroll-x-contain', 'touch-pan-x']
  for (const token of need) {
    if (!className.includes(token)) missing.push(token)
  }
  return missing
}
