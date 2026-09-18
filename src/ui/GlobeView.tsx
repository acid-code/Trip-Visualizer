import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Cartesian2,
  type Entity,
  type Viewer,
} from 'cesium'
import type { TripItem, TripMeta } from '../domain/types'
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
  flyToItemsOverview,
  flyToOpeningItem,
  flyToRouteCoords,
  flyToTripOverview,
  firstOpenableStep,
  lonLatToCanvasCss,
  parseTripEndpoint,
  parseTripItemId,
  pickScreenLonLat,
  captureGlobeMapFocus,
  applyGlobeMapFocus,
  routeMidpoint,
  setGlobeRenderActive,
  syncSelectedPathHighlight,
  syncExploreEntities,
  syncTempPinEntities,
  syncTripEntities,
  type ExplorePinDraw,
  type MapStack,
  DEFAULT_MAP_STACK,
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
  /** Second quick tap on empty map — e.g. clear temp pin */
  onMapDoubleTap?: () => void
  overviewToken?: number
  /** When bumped, frame these items (AI new-spot overview) instead of the full trip. */
  subsetFitToken?: number
  subsetFitItems?: TripItem[]
  /** When this changes (e.g. active trip id), frame the first step for opening */
  tripFocusId?: string | null
  /** Phone: open flights on departure (leg A) instead of the full arc */
  openingOriginOnly?: boolean
  /** Phone: looser pin zoom + raise target above the bottom dock */
  phoneFraming?: boolean
  /** When false, pause the WebGL render loop (Plan mode / background). */
  renderActive?: boolean
  /** Parent registers capture/apply so Journey↔Plan can keep the same map focus. */
  mapFocusApiRef?: MutableRefObject<import('../data/mapFocus').MapFocusApi | null>
  /** Fired once when the Cesium viewer is up and the globe has a first tile settle (or timeout). */
  onBootReady?: () => void
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
/** Finger jitter cancel for long-press only (phones wobble more than 12px). */
const LONG_PRESS_CANCEL_PX = 28
/** Real pan — ignore the click that fires after a drag. */
const TAP_PAN_PX = 52
/** Second tap within this window clears a temp pin. */
const DOUBLE_TAP_MS = 420
const DOUBLE_TAP_PX = 56

/** Stable key so we don't clear/redraw paths when only array identity changed. */
function tripEntitiesSyncKey(
  items: TripItem[],
  connectors: RouteConnector[],
  selectedId: string | null | undefined,
  meta: TripMeta | null | undefined,
): string {
  const itemPart = items
    .map((i) => {
      const n = i.routeCoords?.length ?? 0
      const a = n > 0 ? i.routeCoords![0] : null
      const b = n > 1 ? i.routeCoords![n - 1] : null
      return `${i.id}|${i.type}|${i.status}|${i.date}|${i.lat}|${i.lon}|${i.latTo}|${i.lonTo}|${n}|${a?.[0]}|${a?.[1]}|${b?.[0]}|${b?.[1]}`
    })
    .join(';')
  const connPart = connectors
    .map((c) => {
      const n = c.coords.length
      const a = n > 0 ? c.coords[0] : null
      const b = n > 1 ? c.coords[n - 1] : null
      return `${c.id}|${c.mode}|${c.date}|${n}|${a?.[0]}|${a?.[1]}|${b?.[0]}|${b?.[1]}`
    })
    .join(';')
  return `${meta?.startDate}|${meta?.endDate}|${selectedId ?? ''}|${itemPart}|${connPart}`
}

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
  onMapDoubleTap,
  overviewToken,
  subsetFitToken = 0,
  subsetFitItems = [],
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
  tripFocusId = null,
  openingOriginOnly = false,
  phoneFraming = false,
  renderActive = true,
  mapFocusApiRef,
  onBootReady,
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
  const onMapDoubleTapRef = useRef(onMapDoubleTap)
  const walkTargetRef = useRef(walkTarget)
  const onOpenWalkRef = useRef(onOpenWalk)
  const onOpenExploreRef = useRef(onOpenExplore)
  const onExploreSelectRef = useRef(onExploreSelect)
  const pathActionReadyRef = useRef(true)
  const [pathActionReady, setPathActionReady] = useState(true)
  const routeFlyGenRef = useRef(0)
  const openedTripFocusRef = useRef<string | null>(null)
  /** Opening selection of this step skips pin-zoom once (city/flight frame already applied). */
  const openingStepIdRef = useRef<string | null>(null)
  const tripFocusIdRef = useRef(tripFocusId)
  tripFocusIdRef.current = tripFocusId
  const openingOriginOnlyRef = useRef(openingOriginOnly)
  openingOriginOnlyRef.current = openingOriginOnly
  const phoneFramingRef = useRef(phoneFraming)
  phoneFramingRef.current = phoneFraming
  const onBootReadyRef = useRef(onBootReady)
  onBootReadyRef.current = onBootReady

  const mapStackRef = useRef(mapStack)
  mapStackRef.current = mapStack
  const googleKeyRef = useRef(googleKey)
  googleKeyRef.current = googleKey

  itemsRef.current = items
  connectorsRef.current = connectors
  metaRef.current = meta
  selectedRef.current = selectedId
  onSelectRef.current = onSelect
  onLongPressRef.current = onLongPress
  onMapPressRef.current = onMapPress
  onMapDoubleTapRef.current = onMapDoubleTap
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
      const rect = v.scene.canvas.getBoundingClientRect()
      overlay.style.display = 'flex'
      overlay.style.left = `${rect.left + p.x}px`
      overlay.style.top = `${rect.top + p.y}px`
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
    let pressPanned = false
    let lastEmptyTapAt = 0
    let lastEmptyTap: { x: number; y: number } | null = null

    const clearPressTimer = () => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
    }

    let syncWalkRaf: number | null = null
    const syncWalkButton = () => {
      if (syncWalkRaf != null) return
      syncWalkRaf = requestAnimationFrame(() => {
        syncWalkRaf = null
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
          // Portal is fixed to the viewport — offset by the canvas rect.
          const rect = v.scene.canvas.getBoundingClientRect()
          overlay.style.display = 'flex'
          overlay.style.left = `${rect.left + p.x}px`
          overlay.style.top = `${rect.top + p.y}px`
        } catch {
          overlay.style.display = 'none'
        }
      })
    }

    let bootTileCleanup: (() => void) | undefined
    let bootTimer: ReturnType<typeof setTimeout> | null = null
    let bootNotified = false
    const notifyBoot = () => {
      if (bootNotified || cancelled) return
      bootNotified = true
      if (bootTimer) {
        clearTimeout(bootTimer)
        bootTimer = null
      }
      bootTileCleanup?.()
      bootTileCleanup = undefined
      onBootReadyRef.current?.()
    }
    // Cap even if createTripViewer hangs (stale Cesium after SW update).
    bootTimer = setTimeout(notifyBoot, 3200)

    ;(async () => {
      try {
        viewer = await createTripViewer(container, {
          ionToken,
          phone: phoneFramingRef.current,
        })
      } catch (err) {
        console.error('[globe] createTripViewer failed', err)
        notifyBoot()
        return
      }
      if (cancelled) {
        viewer.destroy()
        return
      }
      viewerRef.current = viewer
      void applyMapStack(viewer, mapStackRef.current || DEFAULT_MAP_STACK, googleKeyRef.current)

      // Signal boot splash once tiles settle (or keep the cap above).
      const removeTileProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener(
        (queued: number) => {
          if (queued === 0) notifyBoot()
        },
      )
      bootTileCleanup =
        typeof removeTileProgress === 'function' ? removeTileProgress : undefined
      viewer.scene.requestRender()

      ro = new ResizeObserver((entries) => {
        try {
          const entry = entries[0]
          const box = entry?.contentRect
          if (box && box.width > 0 && box.height > 0) {
            const prev = (ro as ResizeObserver & { __last?: string }).__last
            const next = `${Math.round(box.width)}x${Math.round(box.height)}`
            if (prev === next) return
            ;(ro as ResizeObserver & { __last?: string }).__last = next
          }
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
        pressPanned = false
        pressStart = { x: movement.position.x, y: movement.position.y }
        clearPressTimer()
        pressTimer = setTimeout(() => {
          pressTimer = null
          const v = viewerRef.current
          const start = pressStart
          if (!v || !start || pressPanned) return
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
        const d2 = dx * dx + dy * dy
        // Small wobble: cancel long-press only (still count as a tap)
        if (d2 > LONG_PRESS_CANCEL_PX * LONG_PRESS_CANCEL_PX) {
          clearPressTimer()
        }
        // Larger move: real pan — ignore the click Cesium fires on finger-up
        if (d2 > TAP_PAN_PX * TAP_PAN_PX) {
          pressPanned = true
          pressStart = null
          clearPressTimer()
        }
      }, ScreenSpaceEventType.MOUSE_MOVE)

      handler.setInputAction(() => {
        clearPressTimer()
      }, ScreenSpaceEventType.LEFT_UP)

      handler.setInputAction((movement: { position: Cartesian2 }) => {
        if (longPressFired) {
          longPressFired = false
          return
        }
        // Pan / slide — don't treat as a tap
        if (pressPanned) {
          pressPanned = false
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

        // Empty map only — dismiss sheets; trip pins open Steps via onSelect
        const isTrip =
          !!entity &&
          typeof entity.id === 'string' &&
          String(entity.id).startsWith('trip:')
        if (!isTrip) {
          onMapPressRef.current?.()
        }

        if (isTrip) {
          lastEmptyTapAt = 0
          lastEmptyTap = null
          const entityId = String(entity!.id)
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
            entityId.endsWith(':seq') ||
            entityId.endsWith(':mid')
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
            const isTripTransport =
              !!item &&
              (item.type === 'flight' ||
                item.type === 'train' ||
                item.type === 'bus' ||
                item.type === 'ferry' ||
                item.type === 'drive')
            // Focus the mid-path emoji for trip legs; otherwise the destination pin
            focusedEntityIdRef.current = isTripTransport
              ? `trip:${itemId}:mid`
              : item?.latTo != null && item?.lonTo != null
                ? `trip:${itemId}:b`
                : `trip:${itemId}`
            // Avoid Cesium's default selection chrome — we draw our own path glow
            viewer!.selectedEntity = undefined

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
          viewer!.selectedEntity = undefined
          onSelectRef.current({
            kind: 'step',
            itemId,
            endpoint: focusEndpointRef.current,
          })
          return
        }

        // Empty map — double-tap clears temp pin (single tap is too easy to confuse with a pan)
        const now = performance.now()
        const prev = lastEmptyTap
        if (
          prev &&
          now - lastEmptyTapAt < DOUBLE_TAP_MS &&
          (movement.position.x - prev.x) ** 2 + (movement.position.y - prev.y) ** 2 <
            DOUBLE_TAP_PX * DOUBLE_TAP_PX
        ) {
          lastEmptyTapAt = 0
          lastEmptyTap = null
          onMapDoubleTapRef.current?.()
        } else {
          lastEmptyTapAt = now
          lastEmptyTap = { x: movement.position.x, y: movement.position.y }
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
        const focusId = tripFocusIdRef.current
        const first = firstOpenableStep(itemsRef.current)
        if (focusId && first && openedTripFocusRef.current !== focusId) {
          openedTripFocusRef.current = focusId
          openingStepIdRef.current = first.id
          flyToOpeningItem(viewerRef.current, first, {
            originOnly: openingOriginOnlyRef.current,
          })
        }
        syncWalkButton()
      })
    })()

    return () => {
      cancelled = true
      clearPressTimer()
      if (bootTimer) clearTimeout(bootTimer)
      bootTileCleanup?.()
      if (syncWalkRaf != null) cancelAnimationFrame(syncWalkRaf)
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
    if (!mapFocusApiRef) return
    mapFocusApiRef.current = {
      capture: () => {
        const v = viewerRef.current
        if (!v || v.isDestroyed()) return null
        return captureGlobeMapFocus(v)
      },
      apply: (focus) => {
        const v = viewerRef.current
        if (!v || v.isDestroyed()) return
        applyGlobeMapFocus(v, focus)
      },
    }
    return () => {
      mapFocusApiRef.current = null
    }
  }, [mapFocusApiRef])

  const lastTripSyncKeyRef = useRef('')

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const key = tripEntitiesSyncKey(items, connectors, selectedId, meta)
    if (key === lastTripSyncKeyRef.current) return
    lastTripSyncKeyRef.current = key
    try {
      syncTripEntities(viewer, items, selectedId, connectors, meta)
    } catch (err) {
      console.warn('[globe] syncTripEntities failed', err)
    }
  }, [items, connectors, meta, selectedId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    try {
      applySelectionHighlight(viewer, selectedId ?? null, focusedEntityIdRef.current)
    } catch (err) {
      console.warn('[globe] applySelectionHighlight failed', err)
    }
  }, [selectedId])

  useEffect(() => {
    const apply = () => {
      const visible = renderActive && typeof document !== 'undefined' && !document.hidden
      setGlobeRenderActive(viewerRef.current, visible)
    }
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [renderActive])

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
    if (coords) beginRouteFlyRef.current(coords)
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
    // Keep the mid-path transport emoji focused while the path glow is active
    if (
      selectedId &&
      (walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights')
    ) {
      const item = itemsRef.current.find((i) => i.id === selectedId)
      if (
        item &&
        (item.type === 'flight' ||
          item.type === 'train' ||
          item.type === 'bus' ||
          item.type === 'ferry' ||
          item.type === 'drive')
      ) {
        focusedEntityIdRef.current = `trip:${selectedId}:mid`
      }
    }
    applySelectionHighlight(viewer, selectedId ?? null, focusedEntityIdRef.current)
  }, [selectedId, walkTarget])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    void applyMapStack(viewer, mapStack || DEFAULT_MAP_STACK, googleKey)
  }, [mapStack, googleKey])

  useEffect(() => {
    /* ion terrain skipped */
  }, [ionToken])

  // Open each trip on its first step (city / flight framing — not pin-select zoom)
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !tripFocusId) return
    if (openedTripFocusRef.current === tripFocusId) return
    const first = firstOpenableStep(items)
    if (!first) return
    openedTripFocusRef.current = tripFocusId
    openingStepIdRef.current = first.id
    flyToOpeningItem(viewer, first, { originOnly: openingOriginOnly })
  }, [tripFocusId, items, openingOriginOnly])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !selectedId) return
    if (openingStepIdRef.current && selectedId === openingStepIdRef.current) {
      openingStepIdRef.current = null
      return
    }
    // Path taps frame the whole route themselves — don't zoom to the destination pin
    if (walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights') {
      focusEndpointRef.current = null
      return
    }
    const item = itemsRef.current.find((i) => i.id === selectedId)
    if (!item) return
    const endpoint = focusEndpointRef.current
    focusEndpointRef.current = null
    flyToItem(
      viewer,
      item,
      endpoint,
      phoneFramingRef.current ? 'phone' : 'desktop',
    )
  }, [selectedId, walkTarget])

  // Only when Overview is pressed — NOT on every items change (that zoomed out on add)
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || overviewToken == null || overviewToken < 1) return
    flyToTripOverview(viewer, itemsRef.current)
  }, [overviewToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !subsetFitToken || subsetFitToken < 1) return
    if (!subsetFitItems.length) return
    flyToItemsOverview(viewer, subsetFitItems)
    // Intentionally token-driven; items snapshot is taken at bump time from App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsetFitToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !tempPin || !tempFlyToken) return
    if (!isValidCoord(tempPin.lat, tempPin.lon)) return
    // Keep the pin mid-screen so Explore/Walk stay clear of top chrome + status.
    flyToCoords(viewer, tempPin.lon, tempPin.lat, {
      range: phoneFramingRef.current ? 900 : 380,
      raisePin: phoneFramingRef.current ? 0.06 : 0.12,
      pitchDeg: phoneFramingRef.current ? -52 : -32,
    })
  }, [tempFlyToken, tempPin])

  useEffect(() => {
    const overlay = walkOverlayRef.current
    const v = viewerRef.current
    if (!overlay) return
    if (!renderActive || !walkTarget || !v) {
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
      const rect = v.scene.canvas.getBoundingClientRect()
      overlay.style.display = 'flex'
      overlay.style.left = `${rect.left + p.x}px`
      overlay.style.top = `${rect.top + p.y}px`
    } catch {
      overlay.style.display = 'none'
    }
  }, [walkTarget, selectedId, tempPin, pathActionReady, renderActive])

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
  // Paths: center on the route. Pins: sit ABOVE the pin.
  const actionLift =
    walkTarget?.kind === 'directions' || walkTarget?.kind === 'flights'
      ? etaMins != null
        ? '-translate-y-[calc(50%+0.55rem)]'
        : '-translate-y-1/2'
      : '-translate-y-[3.6rem]'

  const pinActions =
    renderActive && typeof document !== 'undefined'
      ? createPortal(
          <div className="pointer-events-none fixed inset-0 z-[42] overflow-hidden">
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
                  className="pointer-events-auto flex h-8 w-8 touch-manipulation items-center justify-center rounded-full border border-white/85 bg-sky-500/95 text-[13px] leading-none shadow-md"
                  title={actionTitle}
                  onPointerDown={(e) => e.stopPropagation()}
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
                    className="pointer-events-auto flex h-8 w-8 touch-manipulation items-center justify-center rounded-full border border-amber-200/90 bg-amber-400 text-[13px] leading-none text-amber-950 shadow-md"
                    title="Explore nearby"
                    onPointerDown={(e) => e.stopPropagation()}
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
          </div>,
          document.body,
        )
      : null

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0 touch-none" />
      {pinActions}
    </div>
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
