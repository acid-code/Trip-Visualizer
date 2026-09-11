import { useEffect, useRef, useState } from 'react'
import {
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Cartesian2,
  type Entity,
  type Viewer,
} from 'cesium'
import type { TripItem } from '../domain/types'
import type { NearbyStepLink, RouteConnector } from '../data/routes'
import { estimateDriveMinutes, estimateWalkMinutes } from '../data/routes'
import type { WalkLinkTarget } from '../data/mapsLinks'
import { travelModeForLeg, type MapsTravelMode } from '../data/mapsLinks'
import { isValidCoord } from '../data/validate'
import {
  applyMapStack,
  applySelectionHighlight,
  createTripViewer,
  flyToCoords,
  flyToItem,
  flyToRouteCoords,
  flyToTripOverview,
  lonLatToCanvasCss,
  parseTripEndpoint,
  parseTripItemId,
  pickScreenLonLat,
  routeMidpoint,
  syncSelectedPathHighlight,
  syncExploreEntities,
  syncTempPinEntities,
  syncTripEntities,
  type ExplorePinDraw,
  type MapStack,
  type TempPinDraw,
} from '../globe/viewer'

export type MapSelectPayload =
  | { kind: 'step'; itemId: string; endpoint: 'a' | 'b' | null }
  | {
      kind: 'route'
      itemId: string
      origin: { lat: number; lon: number }
      destination: { lat: number; lon: number }
      travelMode: MapsTravelMode
      coords: [number, number][]
    }
  | {
      kind: 'flight'
      itemId: string
      from: string
      to: string
      date: string
      origin: { lat: number; lon: number }
      destination: { lat: number; lon: number }
      coords: [number, number][]
    }

type Props = {
  items: TripItem[]
  connectors?: RouteConnector[]
  meta?: import('../domain/types').TripMeta | null
  selectedId?: string | null
  mapStack: MapStack
  googleKey?: string
  ionToken?: string
  onSelect: (payload: MapSelectPayload) => void
  onLongPress: (pos: { lat: number; lon: number }) => void
  /** Any map tap (pin, road, or empty) — e.g. dismiss Data sheet */
  onMapPress?: () => void
  overviewToken?: number
  tempPin?: TempPinDraw | null
  nearbyLinks?: NearbyStepLink[]
  tempFlyToken?: number
  walkTarget?: WalkLinkTarget | null
  onOpenWalk?: () => void
  onOpenExplore?: () => void
  /** Short-press on a yellow Explore pin */
  onExploreSelect?: (placeId: string) => void
  explorePlaces?: ExplorePinDraw[]
  exploreFocusId?: string | null
  exploreFlyToken?: number
  /** Fly camera back to walk/pin anchor after closing explore detail */
  exploreReturnToken?: number
}

const LONG_PRESS_MS = 520
const MOVE_CANCEL_PX = 12

/**
 * Cesium host stays an empty div. Walk button is a sibling overlay updated
 * via camera events (not postRender) so the globe stays stable.
 */
export function GlobeView({
  items,
  connectors = [],
  meta = null,
  selectedId,
  mapStack,
  googleKey,
  ionToken,
  onSelect,
  onLongPress,
  onMapPress,
  overviewToken,
  tempPin = null,
  nearbyLinks = [],
  tempFlyToken = 0,
  walkTarget = null,
  onOpenWalk,
  onOpenExplore,
  onExploreSelect,
  explorePlaces = [],
  exploreFocusId = null,
  exploreFlyToken = 0,
  exploreReturnToken = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const walkOverlayRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const itemsRef = useRef(items)
  const connectorsRef = useRef(connectors)
  const metaRef = useRef(meta)
  const selectedRef = useRef(selectedId)
  const focusEndpointRef = useRef<'a' | 'b' | null>(null)
  const focusedEntityIdRef = useRef<string | null>(null)
  const onSelectRef = useRef(onSelect)
  const onLongPressRef = useRef(onLongPress)
  const onMapPressRef = useRef(onMapPress)
  const walkTargetRef = useRef(walkTarget)
  const onOpenWalkRef = useRef(onOpenWalk)
  const onOpenExploreRef = useRef(onOpenExplore)
  const onExploreSelectRef = useRef(onExploreSelect)
  const pathActionReadyRef = useRef(true)
  const [pathActionReady, setPathActionReady] = useState(true)
  const routeFlyGenRef = useRef(0)

  itemsRef.current = items
  connectorsRef.current = connectors
  metaRef.current = meta
  selectedRef.current = selectedId
  onSelectRef.current = onSelect
  onLongPressRef.current = onLongPress
  onMapPressRef.current = onMapPress
  walkTargetRef.current = walkTarget
  onOpenWalkRef.current = onOpenWalk
  onOpenExploreRef.current = onOpenExplore
  onExploreSelectRef.current = onExploreSelect
  pathActionReadyRef.current = pathActionReady

  const revealPathAction = (gen: number) => {
    if (gen !== routeFlyGenRef.current) return
    setPathActionReady(true)
    // Position after paint once the button is shown
    requestAnimationFrame(() => {
      const overlay = walkOverlayRef.current
      const v = viewerRef.current
      const target = walkTargetRef.current
      if (!overlay || !v || !target) return
      if (target.kind !== 'directions' && target.kind !== 'flights') return
      const point = walkAnchorPoint(target)
      if (!point) return
      const p = lonLatToCanvasCss(v, point.lon, point.lat)
      if (!p) return
      overlay.style.display = 'flex'
      overlay.style.left = `${p.x}px`
      overlay.style.top = `${p.y}px`
    })
  }

  const beginRouteFly = (coords: [number, number][]) => {
    const viewer = viewerRef.current
    if (!viewer) return
    const gen = ++routeFlyGenRef.current
    setPathActionReady(false)
    flyToRouteCoords(viewer, coords, () => revealPathAction(gen))
  }
  const beginRouteFlyRef = useRef(beginRouteFly)
  beginRouteFlyRef.current = beginRouteFly

  useEffect(() => {
    let cancelled = false
    let viewer: Viewer | null = null
    let handler: ScreenSpaceEventHandler | null = null
    let ro: ResizeObserver | null = null
    let removeCam: (() => void) | undefined
    let removeMove: (() => void) | undefined
    const container = containerRef.current
    if (!container) return

    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let pressStart: { x: number; y: number } | null = null
    let longPressFired = false

    const clearPress = () => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
      pressStart = null
    }

    const syncWalkButton = () => {
      const overlay = walkOverlayRef.current
      const v = viewerRef.current
      const target = walkTargetRef.current
      if (!overlay || !v) return
      if (!target) {
        overlay.style.display = 'none'
        return
      }
      // Path actions wait until the camera finishes framing the route
      if (
        (target.kind === 'directions' || target.kind === 'flights') &&
        !pathActionReadyRef.current
      ) {
        overlay.style.display = 'none'
        return
      }
      try {
        const point = walkAnchorPoint(target)
        if (!point) {
          overlay.style.display = 'none'
          return
        }
        const p = lonLatToCanvasCss(v, point.lon, point.lat)
        if (!p) {
          overlay.style.display = 'none'
          return
        }
        overlay.style.display = 'flex'
        overlay.style.left = `${p.x}px`
        overlay.style.top = `${p.y}px`
      } catch {
        overlay.style.display = 'none'
      }
    }

    ;(async () => {
      viewer = await createTripViewer(container, { ionToken })
      if (cancelled) {
        viewer.destroy()
        return
      }
      viewerRef.current = viewer

      ro = new ResizeObserver(() => {
        try {
          viewerRef.current?.resize()
          syncWalkButton()
        } catch {
          /* ignore */
        }
      })
      ro.observe(container)

      const camRm = viewer.camera.changed.addEventListener(syncWalkButton)
      const moveRm = viewer.camera.moveEnd.addEventListener(syncWalkButton)
      removeCam = typeof camRm === 'function' ? camRm : undefined
      removeMove = typeof moveRm === 'function' ? moveRm : undefined

      handler = new ScreenSpaceEventHandler(viewer.scene.canvas)

      handler.setInputAction((movement: { position: Cartesian2 }) => {
        longPressFired = false
        pressStart = { x: movement.position.x, y: movement.position.y }
        if (pressTimer) clearTimeout(pressTimer)
        pressTimer = setTimeout(() => {
          pressTimer = null
          const v = viewerRef.current
          const start = pressStart
          if (!v || !start) return
          const pos = pickScreenLonLat(v, start.x, start.y)
          if (!pos) return
          longPressFired = true
          pressStart = null
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
              navigator.vibrate(18)
            } catch {
              /* ignore */
            }
          }
          onMapPressRef.current?.()
          onLongPressRef.current(pos)
        }, LONG_PRESS_MS)
      }, ScreenSpaceEventType.LEFT_DOWN)

      handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
        if (!pressStart) return
        const dx = movement.endPosition.x - pressStart.x
        const dy = movement.endPosition.y - pressStart.y
        if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) clearPress()
      }, ScreenSpaceEventType.MOUSE_MOVE)

      handler.setInputAction(() => clearPress(), ScreenSpaceEventType.LEFT_UP)

      handler.setInputAction((movement: { position: Cartesian2 }) => {
        if (longPressFired) {
          longPressFired = false
          return
        }
        const entity = preferMapEntity(viewer!, movement.position)

        // Yellow Explore pin — select that place (same as tapping a card)
        if (entity && typeof entity.id === 'string' && String(entity.id).startsWith('explore:')) {
          viewer!.selectedEntity = entity
          const desc =
            typeof entity.description === 'string'
              ? entity.description
              : entity.description?.getValue?.()
          const placeId = typeof desc === 'string' && desc ? desc : String(entity.id).replace(/^explore:/, '')
          if (placeId) onExploreSelectRef.current?.(placeId)
          return
        }

        // Empty map / trip pick — notify after we know it isn't an explore pin
        onMapPressRef.current?.()

        if (entity && typeof entity.id === 'string' && entity.id.startsWith('trip:')) {
          const entityId = String(entity.id)
          const desc =
            typeof entity.description === 'string'
              ? entity.description
              : entity.description?.getValue?.()
          let itemId = parseTripItemId(entityId)
          if (typeof desc === 'string' && desc && !desc.startsWith('walk:')) {
            itemId = desc
          } else if (itemId.startsWith('walk:')) {
            const m = itemId.match(/->([^:]+)/)
            if (m) itemId = m[1]
          }

          const isPath =
            entityId.endsWith(':arc') ||
            entityId.endsWith(':route') ||
            entityId.endsWith(':seq')
          const item = itemsRef.current.find((i) => i.id === itemId)
          const connector =
            connectorsRef.current.find(
              (c) =>
                entityId === `trip:${c.id}:route` ||
                entityId === `trip:${c.id}:seq` ||
                entityId.includes(c.id),
            ) ??
            connectorsRef.current.find(
              (c) =>
                entityId.includes(`walk:${c.fromItemId}->${c.toItemId}`) ||
                entityId.includes(`walk:${c.fromItemId}`),
            )

          if (isPath) {
            // Flight arcs are not Maps drives — open Google Flights instead
            const pathCoords = routePathCoords(item, connector)
            const ends = routeEndpoints(item, connector)
            focusedEntityIdRef.current =
              item?.latTo != null && item?.lonTo != null
                ? `trip:${itemId}:b`
                : `trip:${itemId}`
            viewer!.selectedEntity = entity

            if (item?.type === 'flight') {
              if (ends && pathCoords && pathCoords.length >= 2) {
                beginRouteFlyRef.current(pathCoords)
                onSelectRef.current({
                  kind: 'flight',
                  itemId,
                  from: item.from || item.place || item.title,
                  to: item.to || item.title,
                  date: item.date,
                  origin: ends.origin,
                  destination: ends.destination,
                  coords: pathCoords,
                })
              } else {
                viewer!.selectedEntity = undefined
              }
              return
            }

            if (ends && pathCoords && pathCoords.length >= 2) {
              beginRouteFlyRef.current(pathCoords)
              onSelectRef.current({
                kind: 'route',
                itemId,
                origin: ends.origin,
                destination: ends.destination,
                travelMode: travelModeForLeg(item?.type, connector?.mode, entityId),
                coords: pathCoords,
              })
            } else if (ends) {
              const fallback: [number, number][] = [
                [ends.origin.lat, ends.origin.lon],
                [ends.destination.lat, ends.destination.lon],
              ]
              beginRouteFlyRef.current(fallback)
              onSelectRef.current({
                kind: 'route',
                itemId,
                origin: ends.origin,
                destination: ends.destination,
                travelMode: travelModeForLeg(item?.type, connector?.mode, entityId),
                coords: fallback,
              })
            } else {
              focusEndpointRef.current =
                item?.latTo != null && item?.lonTo != null ? 'b' : null
              onSelectRef.current({
                kind: 'step',
                itemId,
                endpoint: focusEndpointRef.current,
              })
            }
            return
          }

          focusEndpointRef.current = parseTripEndpoint(entityId)
          focusedEntityIdRef.current = entityId
          viewer!.selectedEntity = entity
          onSelectRef.current({
            kind: 'step',
            itemId,
            endpoint: focusEndpointRef.current,
          })
          return
        }
        viewer!.selectedEntity = undefined
      }, ScreenSpaceEventType.LEFT_CLICK)

      syncTripEntities(
        viewer,
        itemsRef.current,
        selectedRef.current,
        connectorsRef.current,
        metaRef.current,
      )
      requestAnimationFrame(() => {
        if (cancelled || !viewerRef.current) return
        viewerRef.current.resize()
        flyToTripOverview(viewerRef.current, itemsRef.current)
        syncWalkButton()
      })
    })()

    return () => {
      cancelled = true
      clearPress()
      ro?.disconnect()
      try {
        removeCam?.()
      } catch {
        /* ignore */
      }
      try {
        removeMove?.()
      } catch {
        /* ignore */
      }
      handler?.destroy()
      if (viewerRef.current) {
        viewerRef.current.destroy()
        viewerRef.current = null
      } else if (viewer) {
        viewer.destroy()
      }
      if (container) container.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    syncTripEntities(viewer, items, selectedId, connectors, meta)
  }, [items, connectors, meta])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    syncTempPinEntities(viewer, tempPin, nearbyLinks)
  }, [tempPin, nearbyLinks])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    syncExploreEntities(viewer, explorePlaces, exploreFocusId)
  }, [explorePlaces, exploreFocusId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !exploreFlyToken || !exploreFocusId) return
    const place = explorePlaces.find((p) => p.id === exploreFocusId)
    if (!place || !isValidCoord(place.lat, place.lon)) return
    flyToCoords(viewer, place.lon, place.lat, 420)
  }, [exploreFlyToken, exploreFocusId, explorePlaces])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !exploreReturnToken) return
    const target = walkTargetRef.current
    if (!target) return
    const point = walkAnchorPoint(target)
    if (!point) return
    flyToCoords(viewer, point.lon, point.lat, 420)
  }, [exploreReturnToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const coords =
      (walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights') &&
      walkTarget.coords &&
      walkTarget.coords.length >= 2
        ? walkTarget.coords
        : null
    syncSelectedPathHighlight(viewer, coords)
  }, [walkTarget])

  useEffect(() => {
    // Pin / Street View targets show the button immediately
    if (!walkTarget || walkTarget.kind === 'point') {
      setPathActionReady(true)
    }
  }, [walkTarget])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (
      focusedEntityIdRef.current &&
      parseTripItemId(focusedEntityIdRef.current) !== selectedId
    ) {
      focusedEntityIdRef.current = null
    }
    applySelectionHighlight(viewer, selectedId ?? null, focusedEntityIdRef.current)
  }, [selectedId])

  const mapStackApplied = useRef(false)
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (!mapStackApplied.current) {
      mapStackApplied.current = true
      return
    }
    void applyMapStack(viewer, mapStack, googleKey)
  }, [mapStack, googleKey])

  useEffect(() => {
    /* ion terrain skipped */
  }, [ionToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !selectedId) return
    // Path taps frame the whole route themselves — don't zoom to the destination pin
    if (walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights') return
    const item = itemsRef.current.find((i) => i.id === selectedId)
    if (!item) return
    const endpoint = focusEndpointRef.current
    focusEndpointRef.current = null
    flyToItem(viewer, item, endpoint)
  }, [selectedId, walkTarget])

  // Only when Overview is pressed — NOT on every items change (that zoomed out on add)
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || overviewToken == null || overviewToken < 1) return
    flyToTripOverview(viewer, itemsRef.current)
  }, [overviewToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !tempPin || !tempFlyToken) return
    if (!isValidCoord(tempPin.lat, tempPin.lon)) return
    flyToCoords(viewer, tempPin.lon, tempPin.lat, 380)
  }, [tempFlyToken, tempPin])

  useEffect(() => {
    const overlay = walkOverlayRef.current
    const v = viewerRef.current
    if (!overlay) return
    if (!walkTarget || !v) {
      overlay.style.display = 'none'
      return
    }
    if (
      (walkTarget.kind === 'directions' || walkTarget.kind === 'flights') &&
      !pathActionReady
    ) {
      overlay.style.display = 'none'
      return
    }
    try {
      const point = walkAnchorPoint(walkTarget)
      if (!point) {
        overlay.style.display = 'none'
        return
      }
      const p = lonLatToCanvasCss(v, point.lon, point.lat)
      if (!p) {
        overlay.style.display = 'none'
        return
      }
      overlay.style.display = 'flex'
      overlay.style.left = `${p.x}px`
      overlay.style.top = `${p.y}px`
    } catch {
      overlay.style.display = 'none'
    }
  }, [walkTarget, selectedId, tempPin, pathActionReady])

  const isFlight = walkTarget?.kind === 'flights'
  const directionsMode =
    walkTarget?.kind === 'directions' ? walkTarget.travelMode : null
  const etaMins = (() => {
    if (walkTarget?.kind !== 'directions' || !walkTarget.coords?.length) return null
    if (walkTarget.travelMode === 'walking') {
      return estimateWalkMinutes(walkTarget.coords)
    }
    if (walkTarget.travelMode === 'driving') {
      return estimateDriveMinutes(walkTarget.coords)
    }
    return null
  })()
  const actionIcon = isFlight
    ? '✈️'
    : directionsMode === 'driving'
      ? '🚗'
      : directionsMode === 'transit'
        ? '🚌'
        : '🚶'
  const actionTitle = isFlight
    ? 'Open Google Flights'
    : directionsMode === 'driving'
      ? etaMins
        ? `Open driving directions (~${etaMins} min)`
        : 'Open driving directions'
      : directionsMode === 'transit'
        ? 'Open transit directions'
        : directionsMode === 'walking'
          ? etaMins
            ? `Open walking directions (~${etaMins} min)`
            : 'Open walking directions'
          : 'Open nearest Street View'
  const actionLift =
    walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights'
      ? etaMins != null
        ? '-translate-y-[calc(50%+0.55rem)]'
        : '-translate-y-1/2'
      : '-translate-y-[3.6rem]'

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 touch-none" />
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
        <div
          ref={walkOverlayRef}
          className={`absolute hidden ${actionLift} -translate-x-1/2 flex-col items-center gap-0.5`}
        >
          {etaMins != null ? (
            <span className="rounded bg-slate-950/70 px-1 py-px text-[9px] font-medium leading-none text-white/95 tabular-nums whitespace-nowrap">
              ~{etaMins} min
            </span>
          ) : null}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="pointer-events-auto flex h-[24px] w-[24px] items-center justify-center rounded-full border border-white/85 bg-sky-500/95 text-[12px] leading-none shadow-md"
              title={actionTitle}
              onClick={(e) => {
                e.stopPropagation()
                onOpenWalkRef.current?.()
              }}
            >
              {actionIcon}
            </button>
            {walkTarget?.kind === 'point' ? (
              <button
                type="button"
                className="pointer-events-auto flex h-[24px] w-[24px] items-center justify-center rounded-full border border-amber-200/90 bg-amber-400 text-[12px] leading-none text-amber-950 shadow-md"
                title="Explore nearby"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenExploreRef.current?.()
                }}
              >
                ★
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

function walkAnchorPoint(
  target: WalkLinkTarget,
): { lat: number; lon: number } | null {
  if (target.kind === 'point') return target
  if (target.coords && target.coords.length >= 2) {
    return routeMidpoint(target.coords)
  }
  return {
    lat: (target.origin.lat + target.destination.lat) / 2,
    lon: (target.origin.lon + target.destination.lon) / 2,
  }
}

function routePathCoords(
  item: TripItem | undefined,
  connector: RouteConnector | undefined,
): [number, number][] | null {
  if (connector && connector.coords.length >= 2) return connector.coords
  if (item?.routeCoords && item.routeCoords.length >= 2) return item.routeCoords
  if (
    item &&
    isValidCoord(item.lat, item.lon) &&
    isValidCoord(item.latTo, item.lonTo)
  ) {
    return [
      [item.lat!, item.lon!],
      [item.latTo!, item.lonTo!],
    ]
  }
  return null
}

function routeEndpoints(
  item: TripItem | undefined,
  connector: RouteConnector | undefined,
): { origin: { lat: number; lon: number }; destination: { lat: number; lon: number } } | null {
  const coords = routePathCoords(item, connector)
  if (!coords || coords.length < 2) return null
  const a = coords[0]!
  const b = coords[coords.length - 1]!
  return {
    origin: { lat: a[0], lon: a[1] },
    destination: { lat: b[0], lon: b[1] },
  }
}

function preferMapEntity(viewer: Viewer, position: Cartesian2): Entity | null {
  const drilled = viewer.scene.drillPick(position, 16)
  let explore: Entity | null = null
  let trip: Entity | null = null
  for (const p of drilled) {
    const e = p?.id
    if (e && typeof e === 'object' && typeof (e as Entity).id === 'string') {
      const id = String((e as Entity).id)
      if (id.startsWith('explore:') && !explore) explore = e as Entity
      if (id.startsWith('trip:') && !trip) trip = e as Entity
    }
  }
  // Prefer Explore pins when present so short-press selects that place
  return explore ?? trip
}
