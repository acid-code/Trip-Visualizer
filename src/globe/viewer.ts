import {
  ArcType,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Color,
  DistanceDisplayCondition,
  EllipsoidTerrainProvider,
  HeightReference,
  HorizontalOrigin,
  ImageryLayer,
  KeyboardEventModifier,
  LabelStyle,
  NearFarScalar,
  OpenStreetMapImageryProvider,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
  Math as CesiumMath,
  BoundingSphere,
  HeadingPitchRange,
  ColorMaterialProperty,
  PolylineGlowMaterialProperty,
  sampleTerrainMostDetailed,
  Cartographic,
  ConstantProperty,
  EllipsoidGeodesic,
  Matrix4,
  Transforms,
} from 'cesium'
import type { TripItem, TripMeta } from '../domain/types'
import { dayColor, dayColorByIndex } from '../data/dayTheme'
import { stepOrderMap } from '../data/analytics'
import { isValidCoord } from '../data/validate'
import { logClientError, sanitizeEntityId } from '../data/security'

export type MapStack = 'esri' | 'osm' | 'google3d'

let googleTileset: Cesium3DTileset | null = null

function osmLayer(): ImageryLayer {
  return new ImageryLayer(
    new OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
    }),
  )
}

function esriLayer(): ImageryLayer {
  return new ImageryLayer(
    new UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'Esri / Maxar / Earthstar Geographics',
    }),
  )
}

export async function createTripViewer(
  container: HTMLElement,
  _opts?: { ionToken?: string },
): Promise<Viewer> {
  // Use Cesium’s normal baseLayer path (NOT baseLayer:false + removeAll).
  // That combo was leaving a black void with only entity points visible.
  const viewer = new Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: true,
    terrainProvider: new EllipsoidTerrainProvider(),
    baseLayer: esriLayer(),
    requestRenderMode: false,
  })

  viewer.scene.globe.show = true
  viewer.scene.globe.enableLighting = false
  viewer.scene.globe.depthTestAgainstTerrain = false
  viewer.scene.fog.enabled = false
  viewer.scene.globe.tileCacheSize = 2000
  viewer.camera.percentageChanged = 0.08

  configureTouchCameraControls(viewer)

  // Known-good starting view (France / W Europe) before trip overview flies
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(2.5, 46.5, 1_800_000),
  })

  // Resize after layout — 0×0 canvas at construct time also looks “black”
  requestAnimationFrame(() => {
    try {
      viewer.resize()
      viewer.scene.requestRender()
    } catch {
      /* ignore */
    }
  })

  return viewer
}

/** Soft zoom limits — do not mutate the camera during preRender (that blacks out Cesium). */
const MAX_CAMERA_HEIGHT_M = 2.5e7
const MIN_CAMERA_HEIGHT_M = 40

/**
 * Google Earth–style phone gestures:
 * - 1 finger drag → spin / move the globe
 * - 2 finger pinch → zoom
 * - 2 finger drag → tilt the view
 */
function configureTouchCameraControls(viewer: Viewer) {
  const controller = viewer.scene.screenSpaceCameraController

  controller.enableInputs = true
  controller.enableTranslate = true
  controller.enableZoom = true
  controller.enableRotate = true
  controller.enableTilt = true
  controller.enableLook = false

  controller.inertiaSpin = 0.9
  controller.inertiaTranslate = 0.9
  // Snappier / faster pinch on phones; desktop stays a bit softer
  const touch =
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window)
  controller.inertiaZoom = touch ? 0.55 : 0.8
  // Default Cesium zoomFactor is 5 — raise for faster pinch / wheel zoom
  controller.zoomFactor = touch ? 14 : 7

  controller.minimumZoomDistance = MIN_CAMERA_HEIGHT_M
  controller.maximumZoomDistance = MAX_CAMERA_HEIGHT_M
  controller.enableCollisionDetection = true
  controller.maximumTiltAngle = CesiumMath.PI_OVER_TWO

  // One finger = move around the globe
  controller.rotateEventTypes = [CameraEventType.LEFT_DRAG]

  // Pinch zoom (plus mouse wheel / right-drag on desktop)
  controller.zoomEventTypes = [
    CameraEventType.PINCH,
    CameraEventType.WHEEL,
    CameraEventType.RIGHT_DRAG,
  ]

  // Two-finger drag tilts; keep desktop ctrl/right modifiers
  controller.tiltEventTypes = [
    CameraEventType.PINCH,
    CameraEventType.MIDDLE_DRAG,
    { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    { eventType: CameraEventType.RIGHT_DRAG, modifier: KeyboardEventModifier.CTRL },
  ]

  // Stop the browser from stealing pinch-zoom / scroll on the canvas
  const canvas = viewer.scene.canvas
  canvas.style.touchAction = 'none'
  const blockBrowserGesture = (e: TouchEvent) => {
    if (e.touches.length >= 2) e.preventDefault()
  }
  canvas.addEventListener('touchstart', blockBrowserGesture, { passive: false })
  canvas.addEventListener('touchmove', blockBrowserGesture, { passive: false })
}

export async function applyMapStack(
  viewer: Viewer,
  stack: MapStack,
  googleKey?: string,
) {
  if (googleTileset) {
    try {
      viewer.scene.primitives.remove(googleTileset)
    } catch {
      /* ignore */
    }
    googleTileset = null
  }

  viewer.scene.globe.show = true

  const next = stack === 'osm' ? osmLayer() : esriLayer()

  // Swap without leaving zero layers (removeAll → black frame)
  viewer.imageryLayers.add(next)
  while (viewer.imageryLayers.length > 1) {
    viewer.imageryLayers.remove(viewer.imageryLayers.get(0), true)
  }

  if (stack === 'google3d' && googleKey) {
    try {
      googleTileset = await Cesium3DTileset.fromUrl(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(googleKey)}`,
      )
      viewer.scene.primitives.add(googleTileset)
    } catch (err) {
      logClientError('google3d', err)
    }
  }
}

/** Ion world terrain — intentionally no-op while diagnosing black-globe issues. */
export async function applyIonTerrain(_viewer: Viewer, _ionToken: string) {
  // Re-enable later: Ion.defaultAccessToken + createWorldTerrainAsync
}

export function clearTripEntities(viewer: Viewer) {
  const remove = viewer.entities.values.filter((e) => String(e.id).startsWith('trip:'))
  for (const e of remove) viewer.entities.remove(e)
}

function colorForDay(
  meta: TripMeta | null | undefined,
  date: string | undefined,
  dayNumber: number,
): Color {
  const css =
    meta && date ? dayColor(meta, date) : dayColorByIndex(Math.max(1, dayNumber || 1))
  return Color.fromCssColorString(css)
}

function stepBadge(order?: { day: number; stepInDay: number } | null): string {
  if (!order || !order.day) return '·'
  return `${order.day}.${order.stepInDay}`
}

function midpointLonLat(
  coords: [number, number][],
): { lon: number; lat: number } | null {
  if (coords.length < 2) return null

  // True mid-distance along the path (not the middle array index — that put
  // 2-point flight arcs on the destination airport).
  const segLens: number[] = []
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!
    const b = coords[i]!
    try {
      const geo = new EllipsoidGeodesic(
        Cartographic.fromDegrees(a[1], a[0]),
        Cartographic.fromDegrees(b[1], b[0]),
      )
      const d = geo.surfaceDistance
      segLens.push(d)
      total += d
    } catch {
      segLens.push(0)
    }
  }

  if (!(total > 0)) {
    const a = coords[0]!
    const b = coords[coords.length - 1]!
    return { lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2 }
  }

  let remain = total / 2
  for (let i = 1; i < coords.length; i++) {
    const d = segLens[i - 1]!
    if (remain <= d || i === coords.length - 1) {
      const a = coords[i - 1]!
      const b = coords[i]!
      const frac = d > 0 ? Math.min(1, Math.max(0, remain / d)) : 0.5
      try {
        const geo = new EllipsoidGeodesic(
          Cartographic.fromDegrees(a[1], a[0]),
          Cartographic.fromDegrees(b[1], b[0]),
        )
        const mid = geo.interpolateUsingFraction(frac)
        return {
          lon: CesiumMath.toDegrees(mid.longitude),
          lat: CesiumMath.toDegrees(mid.latitude),
        }
      } catch {
        return {
          lat: a[0] + (b[0] - a[0]) * frac,
          lon: a[1] + (b[1] - a[1]) * frac,
        }
      }
    }
    remain -= d
  }

  const last = coords[coords.length - 1]!
  return { lat: last[0], lon: last[1] }
}

/** Midpoint along a [lat, lon] polyline (for overlay icons on routes). */
export function routeMidpoint(
  coords: [number, number][],
): { lat: number; lon: number } | null {
  const mid = midpointLonLat(coords)
  return mid ? { lat: mid.lat, lon: mid.lon } : null
}

const SURFACE_H = 1.5

function addSeqLabel(
  viewer: Viewer,
  baseId: string,
  lon: number,
  lat: number,
  _height: number,
  badge: string,
  color: Color,
  description: string,
) {
  viewer.entities.add({
    id: `trip:${baseId}:seq`,
    position: Cartesian3.fromDegrees(lon, lat, SURFACE_H),
    label: {
      text: badge,
      font: '700 11px "DM Sans", Segoe UI, sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.CENTER,
      horizontalOrigin: HorizontalOrigin.CENTER,
      heightReference: HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: color.withAlpha(0.9),
      backgroundPadding: new Cartesian2(6, 4),
      show: true,
      distanceDisplayCondition: new DistanceDisplayCondition(0.0, 5e5),
      // Prefer picking pins over badges
      scale: 0.95,
    },
    description,
  })
}

function addBillboard(
  viewer: Viewer,
  item: TripItem,
  lon: number,
  lat: number,
  opts: {
    suffix?: string
    badge: string
    color: Color
    selected: boolean
  },
) {
  const selected = opts.selected
  viewer.entities.add({
    id: `trip:${sanitizeEntityId(item.id)}${opts.suffix ?? ''}`,
    name: item.title,
    position: Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: selected ? 16 : item.type === 'hotel' ? 13 : 10,
      color: opts.color,
      outlineColor: Color.WHITE,
      outlineWidth: selected ? 3 : 2,
      heightReference: HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new NearFarScalar(5e3, 1.35, 2.5e6, 0.55),
    },
    label: {
      text: selected ? item.title : opts.badge,
      font: '600 13px "DM Sans", Segoe UI, sans-serif',
      fillColor: Color.fromCssColorString('#1c1917'),
      outlineColor: Color.WHITE,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: new Cartesian2(0, -14),
      heightReference: HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#fffaf3ee'),
      backgroundPadding: new Cartesian2(8, 5),
      show: true,
      distanceDisplayCondition: new DistanceDisplayCondition(0.0, 4.5e5),
    },
    description: sanitizeEntityId(item.id),
    properties: {
      badgeText: opts.badge,
    },
  })
}

function addArc(
  viewer: Viewer,
  item: TripItem,
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  glow: boolean,
  color: Color,
  badge: string,
) {
  const positions = [
    Cartesian3.fromDegrees(lon1, lat1, SURFACE_H),
    Cartesian3.fromDegrees(lon2, lat2, SURFACE_H),
  ]
  viewer.entities.add({
    id: `trip:${sanitizeEntityId(item.id)}:arc`,
    name: `${item.from} → ${item.to}`,
    polyline: {
      positions,
      width: glow ? 4 : 3.5,
      clampToGround: false,
      material: glow
        ? new PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color,
          })
        : new ColorMaterialProperty(color.withAlpha(0.95)),
      arcType: ArcType.GEODESIC,
    },
    description: sanitizeEntityId(item.id),
  })
  addSeqLabel(
    viewer,
    sanitizeEntityId(item.id),
    (lon1 + lon2) / 2,
    (lat1 + lat2) / 2,
    SURFACE_H,
    badge,
    color,
    item.id,
  )
}

function addRoute(
  viewer: Viewer,
  item: TripItem,
  coords: [number, number][],
  color: Color,
  badge: string,
) {
  if (coords.length < 2) return
  viewer.entities.add({
    id: `trip:${sanitizeEntityId(item.id)}:route`,
    name: item.title,
    polyline: {
      positions: coords.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, SURFACE_H)),
      width: 5,
      clampToGround: false,
      material: new ColorMaterialProperty(color.withAlpha(0.95)),
    },
    description: sanitizeEntityId(item.id),
  })
  const mid = midpointLonLat(coords)
  if (mid) {
    const sid = sanitizeEntityId(item.id)
    addSeqLabel(viewer, sid, mid.lon, mid.lat, SURFACE_H, badge, color, sid)
  }
}

function addConnectorRoute(
  viewer: Viewer,
  connector: {
    id: string
    mode: 'drive' | 'walk'
    coords: [number, number][]
    toItemId?: string
    date?: string
    sequenceInDay?: number
  },
  color: Color,
  badge: string,
) {
  if (connector.coords.length < 2) return
  const alpha = connector.mode === 'walk' ? 0.75 : 0.95
  viewer.entities.add({
    id: `trip:${connector.id}:route`,
    name: connector.mode === 'walk' ? 'Walk' : 'Drive',
    polyline: {
      positions: connector.coords.map(([lat, lon]) =>
        Cartesian3.fromDegrees(lon, lat, SURFACE_H),
      ),
      width: connector.mode === 'walk' ? 3 : 5,
      clampToGround: false,
      material: new ColorMaterialProperty(color.withAlpha(alpha)),
    },
    description: connector.toItemId || connector.id,
  })
  const mid = midpointLonLat(connector.coords)
  if (mid) {
    addSeqLabel(
      viewer,
      connector.id,
      mid.lon,
      mid.lat,
      SURFACE_H,
      badge,
      color,
      connector.toItemId || connector.id,
    )
  }
}

export function syncTripEntities(
  viewer: Viewer,
  items: TripItem[],
  selectedId?: string | null,
  connectors: Array<{
    id: string
    mode: 'drive' | 'walk'
    coords: [number, number][]
    toItemId?: string
    date?: string
    sequenceInDay?: number
  }> = [],
  meta?: TripMeta | null,
) {
  clearTripEntities(viewer)

  const orders = meta
    ? stepOrderMap(meta, items)
    : new Map<string, { day: number; stepInDay: number }>()

  for (const item of items) {
    if (item.status === 'cancelled' || item.type === 'note') continue

    const hasFrom = isValidCoord(item.lat, item.lon)
    const hasTo = isValidCoord(item.latTo, item.lonTo)
    const order = orders.get(item.id)
    const badge = stepBadge(order)
    const color = colorForDay(meta, item.date, order?.day ?? 1)
    const selected = selectedId === item.id

    if (item.routeCoords && item.routeCoords.length > 1) {
      addRoute(viewer, item, item.routeCoords, color, badge)
      if (hasFrom)
        addBillboard(viewer, item, item.lon!, item.lat!, {
          suffix: ':a',
          badge,
          color,
          selected,
        })
      if (hasTo)
        addBillboard(viewer, item, item.lonTo!, item.latTo!, {
          suffix: ':b',
          badge,
          color,
          selected,
        })
      continue
    }

    if (
      hasFrom &&
      hasTo &&
      (item.type === 'flight' ||
        item.type === 'train' ||
        item.type === 'bus' ||
        item.type === 'ferry' ||
        item.type === 'drive')
    ) {
      addArc(
        viewer,
        item,
        item.lon!,
        item.lat!,
        item.lonTo!,
        item.latTo!,
        item.type === 'flight',
        color,
        badge,
      )
      addBillboard(viewer, item, item.lon!, item.lat!, {
        suffix: ':a',
        badge,
        color,
        selected,
      })
      addBillboard(viewer, item, item.lonTo!, item.latTo!, {
        suffix: ':b',
        badge,
        color,
        selected,
      })
      continue
    }

    if (hasFrom) {
      addBillboard(viewer, item, item.lon!, item.lat!, {
        badge,
        color,
        selected,
      })
    }
  }

  for (const connector of connectors) {
    const toOrder = connector.toItemId ? orders.get(connector.toItemId) : undefined
    const day = toOrder?.day ?? 1
    const step = connector.sequenceInDay ?? toOrder?.stepInDay ?? 0
    const badge =
      day && step ? `${day}.${step}` : stepBadge(toOrder)
    const color = colorForDay(meta, connector.date, day)
    addConnectorRoute(viewer, connector, color, badge)
  }

  applySelectionHighlight(viewer, selectedId ?? null)
}

/** Update highlight/labels without destroying entities (keeps Cesium selection stable). */
export function applySelectionHighlight(
  viewer: Viewer,
  selectedId: string | null,
  focusedEntityId?: string | null,
) {
  for (const entity of viewer.entities.values) {
    const id = String(entity.id)
    if (!id.startsWith('trip:')) continue
    // Midpoint sequence badges stay as-is
    if (id.endsWith(':seq')) continue

    const itemId = parseTripItemId(id)
    const isSelected = !!selectedId && itemId === selectedId
    if (entity.point) {
      entity.point.pixelSize = new ConstantProperty(isSelected ? 16 : 11)
      entity.point.outlineWidth = new ConstantProperty(isSelected ? 3 : 2)
    }
    if (entity.label) {
      const isPin = !id.endsWith(':arc') && !id.endsWith(':route')
      if (!isPin) continue
      const isFocused =
        focusedEntityId != null
          ? id === focusedEntityId
          : !id.endsWith(':b')
      const badgeProp = entity.properties?.badgeText
      const badge =
        badgeProp && typeof badgeProp.getValue === 'function'
          ? badgeProp.getValue()
          : badgeProp
      if (isSelected && isFocused) {
        entity.label.text = new ConstantProperty(entity.name ?? '')
      } else if (badge != null && badge !== '') {
        entity.label.text = new ConstantProperty(String(badge))
      }
      // Badges always remain visible on pins
      entity.label.show = new ConstantProperty(true)
    }
  }
}

export function parseTripItemId(entityId: string): string {
  return String(entityId)
    .replace(/^trip:/, '')
    .replace(/:(a|b|arc|route|seq)$/, '')
}

export function parseTripEndpoint(entityId: string): 'a' | 'b' | null {
  if (entityId.endsWith(':b')) return 'b'
  if (entityId.endsWith(':a')) return 'a'
  return null
}

function flyToLonLat(viewer: Viewer, lon: number, lat: number, range = 420) {
  const pin = Cartesian3.fromDegrees(lon, lat, 0)
  // Look slightly south of the pin so it sits in the upper map (above the Detail sheet)
  const enu = Transforms.eastNorthUpToFixedFrame(pin)
  const lookShift = new Cartesian3(0, -Math.max(range * 0.42, 140), 0)
  const lookTarget = Matrix4.multiplyByPoint(enu, lookShift, new Cartesian3())
  viewer.camera.flyToBoundingSphere(new BoundingSphere(lookTarget, 28), {
    duration: 0.85,
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-30), range),
  })
}

export function flyToCoords(viewer: Viewer, lon: number, lat: number, range = 420) {
  flyToLonLat(viewer, lon, lat, range)
}

/** Frame an entire drive/walk/transit path so the whole route is visible and centered. */
export function flyToRouteCoords(
  viewer: Viewer,
  coords: [number, number][],
  onComplete?: () => void,
) {
  if (coords.length < 2) {
    const only = coords[0]
    if (only) flyToLonLat(viewer, only[1], only[0], 600)
    onComplete?.()
    return
  }
  const pts = coords.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, 0))
  const sphere = BoundingSphere.fromPoints(pts)
  const range = Math.min(
    Math.max(sphere.radius * 2.6, 900),
    MAX_CAMERA_HEIGHT_M * 0.9,
  )
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.15,
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-38), range),
    complete: onComplete,
    cancel: onComplete,
  })
}

/** Lon/lat under a canvas CSS pixel (client coords relative to canvas). */
export function pickScreenLonLat(
  viewer: Viewer,
  canvasX: number,
  canvasY: number,
): { lon: number; lat: number } | null {
  const cartesian = viewer.camera.pickEllipsoid(
    new Cartesian2(canvasX, canvasY),
    viewer.scene.globe.ellipsoid,
  )
  if (!cartesian) return null
  const carto = Cartographic.fromCartesian(cartesian)
  const lat = CesiumMath.toDegrees(carto.latitude)
  const lon = CesiumMath.toDegrees(carto.longitude)
  if (!isValidCoord(lat, lon)) return null
  return { lat, lon }
}

/** @deprecated use pickScreenLonLat — kept for call sites mid-refactor */
export function pickCanvasCenterLonLat(
  viewer: Viewer,
): { lon: number; lat: number } | null {
  const canvas = viewer.scene.canvas
  return pickScreenLonLat(viewer, canvas.clientWidth / 2, canvas.clientHeight / 2)
}

export function clearTempEntities(viewer: Viewer) {
  const remove = viewer.entities.values.filter((e) => String(e.id).startsWith('temp:'))
  for (const e of remove) viewer.entities.remove(e)
}

function clearExploreEntities(viewer: Viewer) {
  const remove = viewer.entities.values.filter((e) => String(e.id).startsWith('explore:'))
  for (const e of remove) viewer.entities.remove(e)
}

export type ExplorePinDraw = {
  id: string
  lat: number
  lon: number
  name: string
}

/** Nearby Explore POI markers (`explore:` prefix). */
export function syncExploreEntities(
  viewer: Viewer,
  places: ExplorePinDraw[],
  focusedId?: string | null,
) {
  clearExploreEntities(viewer)
  const accent = Color.fromCssColorString('#f59e0b')
  const focus = Color.fromCssColorString('#facc15')
  for (const place of places) {
    if (!isValidCoord(place.lat, place.lon)) continue
    const selected = focusedId === place.id
    const sid = sanitizeEntityId(place.id.replace(/^osm:/, ''), 48)
    viewer.entities.add({
      id: `explore:${sid}`,
      name: place.name,
      position: Cartesian3.fromDegrees(place.lon, place.lat, SURFACE_H),
      point: {
        pixelSize: selected ? 16 : 11,
        color: selected ? focus : accent,
        outlineColor: Color.WHITE,
        outlineWidth: selected ? 3 : 2,
        heightReference: HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description: place.id,
    })
  }
}

function clearSelectedPathEntities(viewer: Viewer) {
  const remove = viewer.entities.values.filter((e) => String(e.id).startsWith('sel:path'))
  for (const e of remove) viewer.entities.remove(e)
}

/**
 * Yellow glow along the chosen drive/walk/flight path, with bright dots at start & end.
 * Uses `sel:path*` ids so temp-pin sync does not wipe it.
 */
export function syncSelectedPathHighlight(
  viewer: Viewer,
  coords: [number, number][] | null,
) {
  clearSelectedPathEntities(viewer)
  if (!coords || coords.length < 2) return

  const glow = Color.fromCssColorString('#facc15')
  const tip = Color.fromCssColorString('#fde68a')
  // Densify 2-point legs (flights) so the glow follows the great-circle like the arc
  const drawCoords = coords.length === 2 ? densifyGeodesic(coords, 48) : coords

  viewer.entities.add({
    id: 'sel:path:line',
    polyline: {
      positions: drawCoords.map(([lat, lon]) =>
        Cartesian3.fromDegrees(lon, lat, SURFACE_H + 0.5),
      ),
      width: 8,
      clampToGround: false,
      material: new PolylineGlowMaterialProperty({
        glowPower: 0.35,
        color: glow.withAlpha(0.95),
      }),
      arcType: coords.length === 2 ? ArcType.GEODESIC : ArcType.NONE,
    },
  })

  const start = coords[0]!
  const end = coords[coords.length - 1]!
  for (const [key, pt] of [
    ['start', start],
    ['end', end],
  ] as const) {
    viewer.entities.add({
      id: `sel:path:${key}`,
      position: Cartesian3.fromDegrees(pt[1], pt[0], SURFACE_H + 0.5),
      point: {
        pixelSize: 14,
        color: tip,
        outlineColor: glow,
        outlineWidth: 3,
        heightReference: HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }
}

/** Sample points along the great-circle between two [lat, lon] ends. */
function densifyGeodesic(
  coords: [number, number][],
  samples: number,
): [number, number][] {
  if (coords.length !== 2) return coords
  const a = coords[0]!
  const b = coords[1]!
  try {
    const geo = new EllipsoidGeodesic(
      Cartographic.fromDegrees(a[1], a[0]),
      Cartographic.fromDegrees(b[1], b[0]),
    )
    const out: [number, number][] = []
    for (let i = 0; i <= samples; i++) {
      const c = geo.interpolateUsingFraction(i / samples)
      out.push([
        CesiumMath.toDegrees(c.latitude),
        CesiumMath.toDegrees(c.longitude),
      ])
    }
    return out
  } catch {
    return coords
  }
}

export type TempPinDraw = {
  lat: number
  lon: number
  label?: string
  loading?: boolean
}

export type TempNearbyDraw = {
  itemId: string
  title: string
  distKm: number
  coords: [number, number][]
}

const NEARBY_LINK_COLORS = ['#f97316', '#06b6d4', '#a78bfa', '#34d399', '#f43f5e']

/** Preview pin + colored “closeness” walks (ids use temp: prefix). */
export function syncTempPinEntities(
  viewer: Viewer,
  pin: TempPinDraw | null,
  nearby: TempNearbyDraw[] = [],
) {
  clearTempEntities(viewer)
  if (!pin || !isValidCoord(pin.lat, pin.lon)) return

  const accent = Color.fromCssColorString('#f97316')
  const label = pin.loading
    ? 'Looking up…'
    : pin.label?.trim() || 'New pin'

  viewer.entities.add({
    id: 'temp:pin',
    name: label,
    position: Cartesian3.fromDegrees(pin.lon, pin.lat, 0),
    point: {
      pixelSize: 18,
      color: accent,
      outlineColor: Color.WHITE,
      outlineWidth: 3,
      heightReference: HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new NearFarScalar(5e3, 1.4, 2.5e6, 0.6),
    },
    label: {
      text: label,
      font: '600 13px "DM Sans", Segoe UI, sans-serif',
      fillColor: Color.fromCssColorString('#1c1917'),
      outlineColor: Color.WHITE,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      horizontalOrigin: HorizontalOrigin.CENTER,
      pixelOffset: new Cartesian2(0, -16),
      heightReference: HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#fff7edee'),
      backgroundPadding: new Cartesian2(8, 5),
      distanceDisplayCondition: new DistanceDisplayCondition(0.0, 4.5e5),
    },
  })

  nearby.forEach((link, idx) => {
    if (!link.coords || link.coords.length < 2) return
    const css = NEARBY_LINK_COLORS[idx % NEARBY_LINK_COLORS.length]!
    const color = Color.fromCssColorString(css)
    const distLabel =
      link.distKm < 1
        ? `${Math.round(link.distKm * 1000)} m`
        : `${link.distKm.toFixed(1)} km`
    const shortTitle =
      link.title.length > 22 ? `${link.title.slice(0, 20)}…` : link.title
    const roadLabel = `${distLabel} → ${shortTitle}`

    viewer.entities.add({
      id: `temp:link:${idx}`,
      name: roadLabel,
      polyline: {
        positions: link.coords.map(([lat, lon]) =>
          Cartesian3.fromDegrees(lon, lat, SURFACE_H),
        ),
        width: 4,
        clampToGround: false,
        material: new ColorMaterialProperty(color.withAlpha(0.9)),
      },
    })
    const mid = midpointLonLat(link.coords)
    if (mid) {
      viewer.entities.add({
        id: `temp:link:${idx}:label`,
        position: Cartesian3.fromDegrees(mid.lon, mid.lat, SURFACE_H),
        label: {
          text: roadLabel,
          font: '700 11px "DM Sans", Segoe UI, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#1c1917'),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          heightReference: HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: color.withAlpha(0.92),
          backgroundPadding: new Cartesian2(7, 4),
          distanceDisplayCondition: new DistanceDisplayCondition(0.0, 5e5),
        },
      })
    }
  })
}

/** Project a lon/lat to canvas CSS pixels (for HTML walk button). */
export function lonLatToCanvasCss(
  viewer: Viewer,
  lon: number,
  lat: number,
): { x: number; y: number } | null {
  const pos = Cartesian3.fromDegrees(lon, lat, 0)
  const windowPos = new Cartesian2()
  const ok = viewer.scene.cartesianToCanvasCoordinates(pos, windowPos)
  if (!ok) return null
  const canvas = viewer.scene.canvas
  const scaleX = canvas.clientWidth / Math.max(1, canvas.width)
  const scaleY = canvas.clientHeight / Math.max(1, canvas.height)
  return { x: windowPos.x * scaleX, y: windowPos.y * scaleY }
}

export function flyToItem(
  viewer: Viewer,
  item: TripItem,
  endpoint: 'a' | 'b' | null = null,
) {
  // Clicked a specific pin — stay on that pin instead of jumping to the whole leg
  if (endpoint === 'b' && isValidCoord(item.latTo, item.lonTo)) {
    flyToLonLat(viewer, item.lonTo!, item.latTo!)
    return
  }

  if (endpoint === 'a' && isValidCoord(item.lat, item.lon)) {
    flyToLonLat(viewer, item.lon!, item.lat!)
    return
  }

  if (
    endpoint == null &&
    isValidCoord(item.lat, item.lon) &&
    isValidCoord(item.latTo, item.lonTo)
  ) {
    const sphere = BoundingSphere.fromPoints([
      Cartesian3.fromDegrees(item.lon!, item.lat!, 0),
      Cartesian3.fromDegrees(item.lonTo!, item.latTo!, 0),
    ])
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.2,
      offset: new HeadingPitchRange(
        0,
        CesiumMath.toRadians(-35),
        Math.max(sphere.radius * 2.2, 1500),
      ),
    })
    return
  }

  if (isValidCoord(item.lat, item.lon)) {
    flyToLonLat(viewer, item.lon!, item.lat!, item.type === 'hotel' ? 380 : 450)
  }
}

export function flyToTripOverview(viewer: Viewer, items: TripItem[]) {
  const pts: Cartesian3[] = []
  for (const item of items) {
    if (isValidCoord(item.lat, item.lon)) {
      pts.push(Cartesian3.fromDegrees(item.lon!, item.lat!))
    }
    if (isValidCoord(item.latTo, item.lonTo)) {
      pts.push(Cartesian3.fromDegrees(item.lonTo!, item.latTo!))
    }
  }
  if (!pts.length) return
  const sphere = BoundingSphere.fromPoints(pts)
  const range = Math.min(
    Math.max(sphere.radius * 2.2, 50000),
    MAX_CAMERA_HEIGHT_M * 0.9,
  )
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.6,
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-40), range),
  })
}

export async function runTour(
  viewer: Viewer,
  items: TripItem[],
  onStep?: (item: TripItem) => void,
  signal?: AbortSignal,
) {
  const stops = items.filter(
    (i) =>
      i.status !== 'cancelled' &&
      i.type !== 'note' &&
      isValidCoord(i.lat, i.lon),
  )
  for (const item of stops) {
    if (signal?.aborted) return
    onStep?.(item)
    flyToItem(viewer, item)
    await new Promise((r) => setTimeout(r, 2200))
  }
}

export async function clampEntityHeights(viewer: Viewer, items: TripItem[]) {
  const cartos: Cartographic[] = []
  for (const item of items) {
    if (isValidCoord(item.lat, item.lon)) {
      cartos.push(Cartographic.fromDegrees(item.lon!, item.lat!))
    }
  }
  if (!cartos.length) return
  try {
    await sampleTerrainMostDetailed(viewer.terrainProvider, cartos)
  } catch {
    // optional
  }
}
