/**
 * In-app feature tips for friends & family.
 * Add a new tip with a unique `id` — users who already finished older tips
 * only see the new ones (seen ids live in IndexedDB `featureGuideSeen`).
 */

export type FeatureTipVisual =
  | 'long-press'
  | 'search'
  | 'tongues'
  | 'pins-paths'
  | 'walk'
  | 'explore'
  | 'plus-save'
  | 'overview'
  | 'drive'

export type FeatureTip = {
  id: string
  title: string
  body: string
  visual: FeatureTipVisual
}

/** Ordered tip deck — append new features at the end with fresh ids. */
export const FEATURE_TIPS: FeatureTip[] = [
  {
    id: 'long-press-pin',
    title: 'Drop a pin',
    body: 'Long-press anywhere on the globe to plant a temporary pin. Hold still — a short buzz means it’s dropped. Double-tap empty map to remove it.',
    visual: 'long-press',
  },
  {
    id: 'map-search',
    title: 'Search places',
    body: 'Tap the magnifier, type a place or paste a Maps link, then press Enter. The pin flies to that spot.',
    visual: 'search',
  },
  {
    id: 'side-tongues',
    title: 'Steps, Stats & Data',
    body: 'The side (or bottom) tongues open your day list, charts, and trip settings. Tap the same tongue again to tuck the panel away.',
    visual: 'tongues',
  },
  {
    id: 'pins-and-paths',
    title: 'Pins & paths',
    body: 'Short-press a step pin to select it. Tap a road or flight arc to frame the whole route and open Walk / Drive / Transit or Flights.',
    visual: 'pins-paths',
  },
  {
    id: 'walk-figure',
    title: 'Street View & walking',
    body: 'When a pin is selected, tap the walking figure for Street View (or Earth). On a path, the same button opens turn-by-turn directions.',
    visual: 'walk',
  },
  {
    id: 'explore-nearby',
    title: 'Explore nearby',
    body: 'On a pin or step, tap the yellow star to discover sights, food, and parks around you — then Add step to save one to your trip.',
    visual: 'explore',
  },
  {
    id: 'save-with-plus',
    title: 'Save with +',
    body: 'After dropping a pin, press the + tongue to turn it into a real step on that day. Nearby steps within 3 km help suggest the date. Double-tap the map if you want to clear the temp pin instead.',
    visual: 'plus-save',
  },
  {
    id: 'clear-temp-pin',
    title: 'Clear a temp pin',
    body: 'Double-tap empty space on the map to remove a temporary pin. Sliding the globe won’t clear it — only a quick double-tap.',
    visual: 'long-press',
  },
  {
    id: 'overview-camera',
    title: 'Overview',
    body: 'Use Overview in the header to zoom the camera back out and see the whole trip at once.',
    visual: 'overview',
  },
  {
    id: 'google-drive-sync',
    title: 'Google Drive backup',
    body: 'In Data, connect Google once, then Save trip to Drive (trip-planer/folder). Open folder / Open opens Drive in the browser or app. Load switches to the matching trip and overwrites it only when the Drive file is newer than your local copy.',
    visual: 'drive',
  },
]

export function parseSeenTipIds(raw: string | undefined | null): Set<string> {
  if (!raw?.trim()) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 200),
    )
  } catch {
    return new Set()
  }
}

export function serializeSeenTipIds(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)].slice(0, 200))
}

/** Tips the user has not dismissed yet — only these auto-show. */
export function unseenFeatureTips(seen: Set<string>): FeatureTip[] {
  return FEATURE_TIPS.filter((t) => !seen.has(t.id))
}
