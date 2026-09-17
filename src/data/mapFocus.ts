/** Shared 2D map focus so Journey (Cesium) and Plan (MapLibre) stay aligned. */

export type MapFocus = {
  lat: number
  lon: number
  /** MapLibre-style zoom; converted to/from Cesium camera height. */
  zoom: number
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686

/** Approximate MapLibre zoom from Cesium camera height (metres). */
export function heightToZoom(heightM: number, lat: number): number {
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  const zoom =
    Math.log2((EARTH_CIRCUMFERENCE_M * cos) / Math.max(heightM, 50)) - 1
  return Math.min(18, Math.max(2, zoom))
}

/** Approximate Cesium camera height from MapLibre zoom. */
export function zoomToHeight(zoom: number, lat: number): number {
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  const z = Math.min(18, Math.max(2, zoom))
  return (EARTH_CIRCUMFERENCE_M * cos) / Math.pow(2, z + 1)
}

export type MapFocusApi = {
  capture: () => MapFocus | null
  apply: (focus: MapFocus) => void
}
