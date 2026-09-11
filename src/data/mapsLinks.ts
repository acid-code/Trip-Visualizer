/** Deep links for Street View / Google Earth / Maps directions. */

export type WalkAppPref = 'maps' | 'earth'

export type MapsTravelMode = 'driving' | 'transit' | 'walking'

export function isWalkAppPref(v: string | null | undefined): v is WalkAppPref {
  return v === 'maps' || v === 'earth'
}

/**
 * Open the nearest Street View panorama to a point.
 * Google snaps `viewpoint` to the closest available car imagery.
 */
export function streetViewUrl(point: { lat: number; lon: number }): string {
  // Official Maps URL API — finds closest panorama to the viewpoint
  const u = new URL('https://www.google.com/maps/@')
  u.searchParams.set('api', '1')
  u.searchParams.set('map_action', 'pano')
  u.searchParams.set('viewpoint', `${point.lat},${point.lon}`)
  return u.toString()
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

/** Pins/temp → Street View (or Earth). Legs → Maps directions in the right mode. */
export function urlForWalkTarget(target: WalkLinkTarget): string {
  if (target.kind === 'directions') {
    return mapsDirectionsUrl(target.origin, target.destination, target.travelMode)
  }
  if (target.prefer === 'earth') return earthLookAtUrl(target)
  return streetViewUrl(target)
}

export function openWalkTarget(target: WalkLinkTarget): void {
  const url = urlForWalkTarget(target)
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Map a trip leg / connector to a Google Maps travel mode. */
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
  if (itemType === 'flight') return 'driving'
  return 'walking'
}
