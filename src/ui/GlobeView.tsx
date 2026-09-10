import { useEffect, useRef } from 'react'
import {
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Cartesian2,
  type Entity,
  type Viewer,
} from 'cesium'
import type { TripItem } from '../domain/types'
import type { RouteConnector } from '../data/routes'
import {
  applyIonTerrain,
  applyMapStack,
  applySelectionHighlight,
  createTripViewer,
  flyToItem,
  flyToTripOverview,
  parseTripEndpoint,
  parseTripItemId,
  syncTripEntities,
  type MapStack,
} from '../globe/viewer'

type Props = {
  items: TripItem[]
  connectors?: RouteConnector[]
  meta?: import('../domain/types').TripMeta | null
  selectedId?: string | null
  mapStack: MapStack
  googleKey?: string
  ionToken?: string
  onSelect: (id: string | null) => void
  overviewToken?: number
}

export function GlobeView({
  items,
  connectors = [],
  meta = null,
  selectedId,
  mapStack,
  googleKey,
  ionToken,
  onSelect,
  overviewToken,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const itemsRef = useRef(items)
  const connectorsRef = useRef(connectors)
  const metaRef = useRef(meta)
  const selectedRef = useRef(selectedId)
  const focusEndpointRef = useRef<'a' | 'b' | null>(null)
  const focusedEntityIdRef = useRef<string | null>(null)
  const onSelectRef = useRef(onSelect)
  itemsRef.current = items
  connectorsRef.current = connectors
  metaRef.current = meta
  selectedRef.current = selectedId
  onSelectRef.current = onSelect

  useEffect(() => {
    let cancelled = false
    let viewer: Viewer | null = null
    let handler: ScreenSpaceEventHandler | null = null
    const container = containerRef.current
    if (!container) return

    ;(async () => {
      viewer = await createTripViewer(container, { ionToken })
      if (cancelled) {
        viewer.destroy()
        return
      }
      viewerRef.current = viewer

      handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
      handler.setInputAction((movement: { position: Cartesian2 }) => {
        const entity = preferTripEntity(viewer!, movement.position)
        if (entity && typeof entity.id === 'string' && entity.id.startsWith('trip:')) {
          const entityId = String(entity.id)
          // Walk connectors store destination step in description
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
          // Path / badge clicks should land on the destination pin, not a neighbor
          if (isPath) {
            focusEndpointRef.current =
              item?.latTo != null && item?.lonTo != null ? 'b' : null
            focusedEntityIdRef.current =
              item?.latTo != null && item?.lonTo != null
                ? `trip:${itemId}:b`
                : `trip:${itemId}`
          } else {
            focusEndpointRef.current = parseTripEndpoint(entityId)
            focusedEntityIdRef.current = entityId
          }
          viewer!.selectedEntity = entity
          onSelectRef.current(itemId)
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
      flyToTripOverview(viewer, itemsRef.current)
    })()

    return () => {
      cancelled = true
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
    if (
      focusedEntityIdRef.current &&
      parseTripItemId(focusedEntityIdRef.current) !== selectedId
    ) {
      focusedEntityIdRef.current = null
    }
    applySelectionHighlight(viewer, selectedId ?? null, focusedEntityIdRef.current)
  }, [selectedId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    void applyMapStack(viewer, mapStack, googleKey)
  }, [mapStack, googleKey])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ionToken) return
    void applyIonTerrain(viewer, ionToken)
  }, [ionToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !selectedId) return
    const item = itemsRef.current.find((i) => i.id === selectedId)
    if (!item) return
    const endpoint = focusEndpointRef.current
    focusEndpointRef.current = null
    flyToItem(viewer, item, endpoint)
  }, [selectedId])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || overviewToken == null) return
    flyToTripOverview(viewer, items)
  }, [overviewToken, items])

  return <div ref={containerRef} className="absolute inset-0 touch-none" />
}

/** Prefer real pins over route/arc/seq midpoints when several entities stack. */
function preferTripEntity(viewer: Viewer, position: Cartesian2): Entity | null {
  const drilled = viewer.scene.drillPick(position, 16)
  const entities: Entity[] = []
  for (const p of drilled) {
    const e = p?.id
    if (e && typeof e === 'object' && typeof (e as Entity).id === 'string') {
      const id = String((e as Entity).id)
      if (id.startsWith('trip:')) entities.push(e as Entity)
    }
  }

  const pin = entities.find((e) => {
    const id = String(e.id)
    return !id.endsWith(':arc') && !id.endsWith(':route') && !id.endsWith(':seq')
  })
  return pin ?? entities[0] ?? null
}
