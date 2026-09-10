import {
  ArcType,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cesium3DTileset,
  Color,
  DistanceDisplayCondition,
  HeightReference,
  HorizontalOrigin,
  Ion,
  KeyboardEventModifier,
  LabelStyle,
  NearFarScalar,
  OpenStreetMapImageryProvider,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
  createWorldTerrainAsync,
  Math as CesiumMath,
  BoundingSphere,
  HeadingPitchRange,
  ColorMaterialProperty,
  PolylineGlowMaterialProperty,
  sampleTerrainMostDetailed,
  Cartographic,
  ConstantProperty,
  Matrix4,
  Transforms,
} from 'cesium'
import type { TripItem, TripMeta } from '../domain/types'
import { dayColor, dayColorByIndex } from '../data/dayTheme'
import { stepOrderMap } from '../data/analytics'

export type MapStack = 'esri' | 'osm' | 'google3d'

let googleTileset: Cesium3DTileset | null = null

export async function createTripViewer(
  container: HTMLElement,
  opts?: { ionToken?: string },
): Promise<Viewer> {
  if (opts?.ionToken) Ion.defaultAccessToken = opts.ionToken

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
    baseLayer: false,
    // Keep previously visited tiles longer so revisiting areas feels instant
    requestRenderMode: false,
  })

  // Larger imagery tile cache → faster when panning back to known areas
  viewer.scene.globe.tileCacheSize = 2000
  viewer.scene.globe.loadingDescendantLimit = 40
  viewer.scene.globe.preloadSiblings = true
  viewer.scene.globe.preloadAncestors = true
  viewer.scene.fog.enabled = false
  viewer.scene.globe.depthTestAgainstTerrain = true
  viewer.camera.percentageChanged = 0.08

  configureTouchCameraControls(viewer)

  await applyMapStack(viewer, 'esri')

  if (opts?.ionToken) {
    try {
      viewer.terrainProvider = await createWorldTerrainAsync()
    } catch {
      // keep ellipsoid
    }
  }

  return viewer
}

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
  controller.inertiaZoom = 0.8

  controller.minimumZoomDistance = 20
  controller.maximumZoomDistance = 4e7
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
  viewer.imageryLayers.removeAll()

  if (googleTileset) {
    viewer.scene.primitives.remove(googleTileset)
    googleTileset = null
  }

  if (stack === 'osm') {
    viewer.scene.globe.show = true
    viewer.imageryLayers.addImageryProvider(
      new OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }),
    )
    return
  }

  if (stack === 'google3d' && googleKey) {
    try {
      googleTileset = await Cesium3DTileset.fromUrl(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(googleKey)}`,
      )
      viewer.scene.primitives.add(googleTileset)
      viewer.scene.globe.show = false
      return
    } catch (err) {
      console.warn('Google Photorealistic 3D failed; using Esri', err)
    }
  }

  viewer.scene.globe.show = true
  viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'Esri / Maxar / Earthstar Geographics',
    }),
  )
}

/** Call when the user adds/changes a Cesium ion token for world terrain elevation. */
export async function applyIonTerrain(viewer: Viewer, ionToken: string) {
  if (!ionToken) return
  Ion.defaultAccessToken = ionToken
  try {
    viewer.terrainProvider = await createWorldTerrainAsync()
  } catch (err) {
    console.warn('World terrain failed', err)
  }
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
  const [lat, lon] = coords[Math.floor(coords.length / 2)]!
  return { lon, lat }
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
      heightReference: HeightReference.CLAMP_TO_GROUND,
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
    id: `trip:${item.id}${opts.suffix ?? ''}`,
    name: item.title,
    position: Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: selected ? 16 : item.type === 'hotel' ? 13 : 10,
      color: opts.color,
      outlineColor: Color.WHITE,
      outlineWidth: selected ? 3 : 2,
      heightReference: HeightReference.CLAMP_TO_GROUND,
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
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#fffaf3ee'),
      backgroundPadding: new Cartesian2(8, 5),
      show: true,
      distanceDisplayCondition: new DistanceDisplayCondition(0.0, 4.5e5),
    },
    description: item.id,
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
    id: `trip:${item.id}:arc`,
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
    description: item.id,
  })
  addSeqLabel(
    viewer,
    item.id,
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
    id: `trip:${item.id}:route`,
    name: item.title,
    polyline: {
      positions: coords.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, SURFACE_H)),
      width: 5,
      clampToGround: false,
      material: new ColorMaterialProperty(color.withAlpha(0.95)),
    },
    description: item.id,
  })
  const mid = midpointLonLat(coords)
  if (mid) {
    addSeqLabel(viewer, item.id, mid.lon, mid.lat, SURFACE_H, badge, color, item.id)
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

    const hasFrom = item.lat != null && item.lon != null
    const hasTo = item.latTo != null && item.lonTo != null
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

export function flyToItem(
  viewer: Viewer,
  item: TripItem,
  endpoint: 'a' | 'b' | null = null,
) {
  // Clicked a specific pin — stay on that pin instead of jumping to the whole leg
  if (endpoint === 'b' && item.latTo != null && item.lonTo != null) {
    flyToLonLat(viewer, item.lonTo, item.latTo)
    return
  }

  if (endpoint === 'a' && item.lat != null && item.lon != null) {
    flyToLonLat(viewer, item.lon, item.lat)
    return
  }

  if (
    endpoint == null &&
    item.lat != null &&
    item.lon != null &&
    item.latTo != null &&
    item.lonTo != null
  ) {
    const sphere = BoundingSphere.fromPoints([
      Cartesian3.fromDegrees(item.lon, item.lat, 0),
      Cartesian3.fromDegrees(item.lonTo, item.latTo, 0),
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

  if (item.lat != null && item.lon != null) {
    flyToLonLat(viewer, item.lon, item.lat, item.type === 'hotel' ? 380 : 450)
  }
}

export function flyToTripOverview(viewer: Viewer, items: TripItem[]) {
  const pts: Cartesian3[] = []
  for (const item of items) {
    if (item.lat != null && item.lon != null) {
      pts.push(Cartesian3.fromDegrees(item.lon, item.lat))
    }
    if (item.latTo != null && item.lonTo != null) {
      pts.push(Cartesian3.fromDegrees(item.lonTo, item.latTo))
    }
  }
  if (!pts.length) return
  const sphere = BoundingSphere.fromPoints(pts)
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.6,
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-40), Math.max(sphere.radius * 2.2, 50000)),
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
      i.lat != null &&
      i.lon != null,
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
    if (item.lat != null && item.lon != null) {
      cartos.push(Cartographic.fromDegrees(item.lon, item.lat))
    }
  }
  if (!cartos.length) return
  try {
    await sampleTerrainMostDetailed(viewer.terrainProvider, cartos)
  } catch {
    // optional
  }
}
