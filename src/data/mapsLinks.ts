/** Deep links for Street View / Google Earth / Maps directions / Flights. */

export type WalkAppPref = 'maps' | 'earth'

export type MapsTravelMode = 'driving' | 'transit' | 'walking'

export function isWalkAppPref(v: string | null | undefined): v is WalkAppPref {
  return v === 'maps' || v === 'earth'
}

/**
 * Open the nearest Street View panorama to a point — no API key needed.
 * Maps URLs snap `viewpoint` to the closest available car imagery.
 * heading/pitch/fov nudge the pano viewer to initialize (reduces blank canvas).
 * https://developers.google.com/maps/documentation/urls/get-started#street-view-action
 */
export function streetViewUrl(point: { lat: number; lon: number }, panoId?: string): string {
  const u = new URL('https://www.google.com/maps/@')
  u.searchParams.set('api', '1')
  u.searchParams.set('map_action', 'pano')
  u.searchParams.set('viewpoint', `${point.lat},${point.lon}`)
  u.searchParams.set('heading', '0')
  u.searchParams.set('pitch', '10')
  u.searchParams.set('fov', '75')
  if (panoId) u.searchParams.set('pano', panoId)
  return u.toString()
}

/** Plain Google Maps look-at (when you want the map, not a panorama). */
export function mapsPlaceUrl(point: { lat: number; lon: number }): string {
  const u = new URL('https://www.google.com/maps/search/')
  u.searchParams.set('api', '1')
  u.searchParams.set('query', `${point.lat},${point.lon}`)
  return u.toString()
}

/** Open a named place in Google Maps (free Maps URL — ratings/reviews live there). */
export function mapsPlaceSearchUrl(
  name: string,
  point: { lat: number; lon: number },
  addressOrOpts?:
    | string
    | {
        address?: string
        category?: string
        cuisine?: string
      },
): string {
  const opts =
    typeof addressOrOpts === 'string'
      ? { address: addressOrOpts }
      : addressOrOpts ?? {}

  const parts: string[] = []
  const title = name.trim()
  if (title) parts.push(title)

  // Disambiguate famous names (e.g. "Taj Mahal" restaurant vs the monument)
  const cat = opts.category || ''
  if (cat === 'food' || cat === 'drink') {
    const cuisine = opts.cuisine?.replace(/[;,|/]+/g, ' ').trim()
    if (cuisine && !title.toLowerCase().includes(cuisine.toLowerCase())) {
      parts.push(cuisine.split(/\s+/)[0]!)
    }
    const kind = cat === 'drink' ? 'bar' : 'restaurant'
    if (!new RegExp(`\\b${kind}\\b`, 'i').test(title)) parts.push(kind)
  } else if (cat === 'hotel') {
    if (!/\bhotel\b/i.test(title)) parts.push('hotel')
  } else if (cat === 'sights' || cat === 'nature') {
    // keep name + address; location bias does the rest
  }

  const address = opts.address?.trim()
  if (address) parts.push(address)

  const query = parts.join(' ').replace(/\s+/g, ' ').trim() || `${point.lat},${point.lon}`
  const lat = Number(point.lat.toFixed(6))
  const lon = Number(point.lon.toFixed(6))
  // Path search + @viewport biases results to this pin (api=1 query+coords often ignores place)
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat},${lon},17z`
}

/** Open Maps centered on the pin looking for this place’s menu (no GPS `near=`). */
export function googleMenuSearchUrl(
  name: string,
  point: { lat: number; lon: number },
  opts?: { address?: string; category?: string; cuisine?: string },
): string {
  // `near=lat,lon` is ignored by Google Search (uses the user’s GPS). Put location in
  // the query and open Maps with the same @lat,lon viewport as reviews.
  const title = name.trim()
  const label = /\bmenu\b/i.test(title) ? title : `${title} menu`
  return mapsPlaceSearchUrl(label, point, {
    address: opts?.address,
    category: opts?.category ?? 'food',
    cuisine: opts?.cuisine,
  })
}

/** Open Google Maps “Things to do” centered on a spot (not the user’s GPS). */
export function mapsNearbyExploreUrl(
  point: { lat: number; lon: number },
  _label?: string,
): string {
  const lat = Number(point.lat.toFixed(6))
  const lon = Number(point.lon.toFixed(6))
  return `https://www.google.com/maps/search/Things+to+do/@${lat},${lon},15z`
}

/** Google Earth look-at for a single point. */
export function earthLookAtUrl(point: { lat: number; lon: number }, altM = 180): string {
  return `https://earth.google.com/web/@${point.lat},${point.lon},${altM}a,0d,35y,0h,0t,0r`
}

/** Google Maps directions A → B with a travel mode. */
export function mapsDirectionsUrl(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  travelMode: MapsTravelMode,
): string {
  const u = new URL('https://www.google.com/maps/dir/')
  u.searchParams.set('api', '1')
  u.searchParams.set('origin', `${origin.lat},${origin.lon}`)
  u.searchParams.set('destination', `${destination.lat},${destination.lon}`)
  u.searchParams.set('travelmode', travelMode)
  return u.toString()
}

/** Google Flights search for a one-way trip on a given date. */
export function googleFlightsUrl(from: string, to: string, date: string): string {
  const origin = from.trim() || 'Origin'
  const dest = to.trim() || 'Destination'
  const day = date.trim()
  const q = day
    ? `Flights from ${origin} to ${dest} on ${day}`
    : `Flights from ${origin} to ${dest}`
  const u = new URL('https://www.google.com/travel/flights')
  u.searchParams.set('q', q)
  u.searchParams.set('curr', 'EUR')
  return u.toString()
}

export type WalkLinkTarget =
  | {
      kind: 'point'
      lat: number
      lon: number
      prefer: WalkAppPref
    }
  | {
      kind: 'directions'
      origin: { lat: number; lon: number }
      destination: { lat: number; lon: number }
      travelMode: MapsTravelMode
      /** Full polyline [lat, lon] when known — used for camera + icon midpoint. */
      coords?: [number, number][]
    }
  | {
      kind: 'flights'
      from: string
      to: string
      date: string
      origin: { lat: number; lon: number }
      destination: { lat: number; lon: number }
      coords?: [number, number][]
    }

/** Pins/temp → Street View (or Earth). Legs → Maps directions. Flights → Google Flights. */
export function urlForWalkTarget(target: WalkLinkTarget): string {
  if (target.kind === 'flights') {
    return googleFlightsUrl(target.from, target.to, target.date)
  }
  if (target.kind === 'directions') {
    return mapsDirectionsUrl(target.origin, target.destination, target.travelMode)
  }
  if (target.prefer === 'earth') return earthLookAtUrl(target)
  // Free Maps URL — Google picks the nearest panorama to the viewpoint
  return streetViewUrl(target)
}

export function openWalkTarget(target: WalkLinkTarget): void {
  openExternalUrl(urlForWalkTarget(target))
}

/** Open a Maps / Flights tab and bring it forward so WebGL panoramas can paint. */
export function openExternalUrl(url: string): void {
  // Skip `noopener` so we can focus — then clear opener for safety.
  const w = window.open(url, '_blank', 'noreferrer')
  try {
    if (w) {
      w.opener = null
      w.focus()
    }
  } catch {
    /* ignore cross-origin / popup quirks */
  }
}

/** Map a trip leg / connector to a Google Maps travel mode (never flights). */
export function travelModeForLeg(
  itemType: string | undefined,
  connectorMode?: 'drive' | 'walk',
  entityId?: string,
): MapsTravelMode {
  // Walk connectors / walk entity ids always mean foot directions
  if (connectorMode === 'walk' || (entityId && entityId.includes('walk:'))) {
    return 'walking'
  }
  if (connectorMode === 'drive') return 'driving'
  if (itemType === 'drive') return 'driving'
  // Train / ferry / bus → public transport
  if (itemType === 'train' || itemType === 'bus' || itemType === 'ferry') {
    return 'transit'
  }
  // Flights are handled separately — never Maps driving
  return 'walking'
}
