/**
 * In-app feature tips for friends & family.
 * Tips are contextual — they auto-show when the user opens a surface
 * (Steps, Settings, …). Arrow coaches are the only default onboarding.
 * Append new tips with unique `id`s so returning users only see new ones
 * (seen ids live in IndexedDB `featureGuideSeen`).
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
  | 'edit-trip'
  | 'new-trip'
  | 'hotel-stay'
  | 'plan-discover'
  | 'plan-days'
  | 'plan-layers'
  | 'sharing'
  | 'my-maps'
  | 'excel'
  | 'day-coach'
  | 'appearance'
  | 'walk-app'
  | 'map-look'
  | 'charts'

/** Where a tip auto-shows when the user opens that surface. */
export type TipContext =
  | 'steps'
  | 'map'
  | 'charts'
  | 'settings'
  | 'plan'
  | 'ai'
  | 'explore'

/** Seen-id for the Plan-mode arrow overlay (not a FeatureGuide card). */
export const PLAN_START_COACH_ID = 'plan-start-coach'

export type FeatureTip = {
  id: string
  title: string
  body: string
  visual: FeatureTipVisual
  context: TipContext
}

/** Ordered tip deck — append new features at the end with fresh ids. */
export const FEATURE_TIPS: FeatureTip[] = [
  {
    id: 'long-press-pin',
    title: 'Drop a pin',
    body: 'Long-press anywhere on the globe to plant a temporary pin. Hold still — a short buzz means it’s dropped. Double-tap empty map to remove it.',
    visual: 'long-press',
    context: 'map',
  },
  {
    id: 'map-search',
    title: 'Search places',
    body: 'Tap the magnifier, type a place or paste a Maps link, then press Enter. The pin flies to that spot.',
    visual: 'search',
    context: 'map',
  },
  {
    id: 'side-tongues',
    title: 'Steps, Stats & Settings',
    body: 'The book dividers along the bottom open your day list, charts, and settings. Tap the same divider again to tuck the sheet away.',
    visual: 'tongues',
    context: 'steps',
  },
  {
    id: 'pins-and-paths',
    title: 'Pins & paths',
    body: 'Short-press a step pin to select it. Tap a road or flight arc to frame the whole route and open Walk / Drive / Transit or Flights.',
    visual: 'pins-paths',
    context: 'map',
  },
  {
    id: 'walk-figure',
    title: 'Street View & walking',
    body: 'When a pin is selected, tap the walking figure for Street View (or Earth). On a path, the same button opens turn-by-turn directions.',
    visual: 'walk',
    context: 'map',
  },
  {
    id: 'explore-nearby',
    title: 'Explore nearby',
    body: 'On a pin or step, tap the yellow star to discover sights, food, and parks around you — then Add step to save one to your trip.',
    visual: 'explore',
    context: 'explore',
  },
  {
    id: 'save-with-plus',
    title: 'Save with +',
    body: 'After dropping a pin, press the + tongue to turn it into a real step on that day. Nearby steps within 3 km help suggest the date. Double-tap the map if you want to clear the temp pin instead.',
    visual: 'plus-save',
    context: 'steps',
  },
  {
    id: 'clear-temp-pin',
    title: 'Clear a temp pin',
    body: 'Double-tap empty space on the map to remove a temporary pin. Sliding the globe won’t clear it — only a quick double-tap.',
    visual: 'long-press',
    context: 'map',
  },
  {
    id: 'overview-camera',
    title: 'Overview',
    body: 'Use Overview in the header to zoom the camera back out and see the whole trip at once.',
    visual: 'overview',
    context: 'map',
  },
  {
    id: 'google-drive-sync',
    title: 'Google Drive backup',
    body: 'In Data, connect Google once (allow Drive access), then Save trip to Drive (trip-planer/). Load updates the open trip when the file name matches, or creates a new trip and switches to it. Files you add yourself in that folder also appear on Refresh.',
    visual: 'drive',
    context: 'settings',
  },
  {
    id: 'edit-trip-meta',
    title: 'Edit name & dates',
    body: 'Tap the trip title in the top-right to rename the trip or change start/end dates. Each day gets a base spot; shrinking dates asks what to do with steps left outside.',
    visual: 'edit-trip',
    context: 'steps',
  },
  {
    id: 'new-trip',
    title: 'Start a new trip',
    body: 'Open the trip menu at the top right, tap the + at the bottom, then give it a name and start/end dates. We’ll add a base spot for each day so the timeline is ready to fill.',
    visual: 'new-trip',
    context: 'steps',
  },
  {
    id: 'hotel-stay-span',
    title: 'Hotels span every night',
    body: 'Add a hotel once with check-in and check-out. The app treats it as your stay for every night in between — filter to a middle day and that hotel still shows up, even though check-in was earlier.',
    visual: 'hotel-stay',
    context: 'steps',
  },
  {
    id: 'plan-mode-discover',
    title: 'Plan · Discover',
    body: 'Switch to Plan to collect ideas before locking times. Discover shows nearby suggestions and your lists — save must-sees, food, and stays without scheduling yet.',
    visual: 'plan-discover',
    context: 'plan',
  },
  {
    id: 'plan-mode-days',
    title: 'Plan · Days',
    body: 'On Days, drag unscheduled list places into day buckets, reorder with ↑↓, and optimize a day. Journey is for exact times and drives later.',
    visual: 'plan-days',
    context: 'plan',
  },
  {
    id: 'plan-mode-layers',
    title: 'Plan map layers',
    body: 'The layers control toggles Nearby suggestions, Journey pins, and which lists appear on the map. In Days, Nearby stays off and Journey stays on so you can focus on the itinerary.',
    visual: 'plan-layers',
    context: 'plan',
  },
  {
    id: 'partner-sharing',
    title: 'Share with a partner',
    body: 'In Settings → Sharing, sign in with Google, enable sharing on this trip, then invite by email. They Join from Sharing on their device. Changes sync near-live while you’re both connected.',
    visual: 'sharing',
    context: 'settings',
  },
  {
    id: 'my-maps-export',
    title: 'Google My Maps layers',
    body: 'In Data & Drive, connect Google, then Prepare for Google Maps. Open the Sheet it creates, and on desktop use Google My Maps → Import to pull each tab as a layer (pins, paths, days).',
    visual: 'my-maps',
    context: 'settings',
  },
  {
    id: 'excel-import-export',
    title: 'Excel import & export',
    body: 'In Data & Drive, export a workbook of your trip or import one you edited. The How to use sheet in the file explains columns — handy for bulk edits offline.',
    visual: 'excel',
    context: 'settings',
  },
  {
    id: 'day-coach-ai',
    title: 'Day Coach (AI)',
    body: 'Tap the AI tongue to ask for a day’s plan. Review suggestions carefully, then Save or Discard — it can rearrange steps, so check the draft before you keep it.',
    visual: 'day-coach',
    context: 'ai',
  },
  {
    id: 'appearance-theme',
    title: 'Cream or dark',
    body: 'In Settings → Appearance, switch the shell between cream paper and a darker look. Your choice sticks on this device.',
    visual: 'appearance',
    context: 'settings',
  },
  {
    id: 'walk-app-pref',
    title: 'Walk opens Maps or Earth',
    body: 'In Settings → Map & keys, choose whether the walking figure opens Google Maps or Google Earth for Street View / directions.',
    visual: 'walk-app',
    context: 'settings',
  },
  {
    id: 'map-look-stack',
    title: 'Map look & layers',
    body: 'Use the map layers control to switch Classic / Modern look and the basemap stack (Esri, OSM, or Google 3D when available). Pick what reads best for your trip.',
    visual: 'map-look',
    context: 'map',
  },
  {
    id: 'stats-charts',
    title: 'Stats & charts',
    body: 'Open the Stats divider for distance, time, and spend charts for the open trip. Filter a day on the timeline first if you want that day only.',
    visual: 'charts',
    context: 'charts',
  },
]

/** Journey coach “Browse tips” — map + steps. */
export const JOURNEY_TIP_CONTEXTS: TipContext[] = ['map', 'steps']

/** Plan coach “Browse tips”. */
export const PLAN_TIP_CONTEXTS: TipContext[] = ['plan']

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

/** Unseen tips for one or more surfaces (preserves deck order). */
export function unseenFeatureTipsForContexts(
  seen: Set<string>,
  contexts: TipContext[],
): FeatureTip[] {
  if (!contexts.length) return []
  const want = new Set(contexts)
  return FEATURE_TIPS.filter((t) => want.has(t.context) && !seen.has(t.id))
}

export function featureTipsForContexts(contexts: TipContext[]): FeatureTip[] {
  if (!contexts.length) return FEATURE_TIPS
  const want = new Set(contexts)
  return FEATURE_TIPS.filter((t) => want.has(t.context))
}
