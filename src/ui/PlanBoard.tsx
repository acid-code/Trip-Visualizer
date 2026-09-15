import { useMemo, useState } from 'react'
import type { PlanPlace, PlanSection, TripRecord } from '../domain/types'
import { listTripDays } from '../data/dayBases'
import {
  addPlanPlace,
  dayTravelLegs,
  optimizeDayRoute,
  promotePlanPlaceToStep,
  removePlanPlace,
  unschedulePlanPlace,
} from '../data/planBoard'
import { REGION_PACKS, findRegionPack } from '../data/regionPacks'
import { createId } from '../data/db'
import { PlanMapView } from '../map/PlanMapView'
import { Chip, IconButton, SegmentedControl } from './primitives'
import { TOUCH_SCROLL_X, TOUCH_SCROLL_Y } from './scrollGesture'

type Props = {
  trip: TripRecord
  onChange: (next: TripRecord) => void
  onAskAi?: (prompt: string) => void
}

type PlanTab = 'itinerary' | 'map'
type RailFocus = string | 'lists' // day iso or lists

/**
 * Phone-first Plan board inspired by Wanderlog:
 * Itinerary ↔ Map, day-first schedule with travel legs, Lists for unscheduled ideas.
 */
export function PlanBoard({ trip, onChange, onAskAi }: Props) {
  const days = listTripDays(trip.meta)
  const [tab, setTab] = useState<PlanTab>('itinerary')
  const [rail, setRail] = useState<RailFocus>(days[0] ?? 'lists')
  const [activeSectionId, setActiveSectionId] = useState(
    trip.planSections[0]?.id ?? '',
  )
  const [focusPlaceId, setFocusPlaceId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [packsOpen, setPacksOpen] = useState(false)

  const railSafe: RailFocus =
    rail === 'lists' || days.includes(rail) ? rail : (days[0] ?? 'lists')

  const visibleSectionIds = useMemo(
    () => new Set(trip.planSections.map((s) => s.id)),
    [trip.planSections],
  )

  const activeDay = railSafe !== 'lists' ? railSafe : days[0] ?? null

  const mapVisibleDays = useMemo(() => {
    if (railSafe === 'lists') return null
    return new Set([railSafe])
  }, [railSafe])

  const unscheduled = trip.planPlaces.filter((p) => !p.scheduledDay)
  const bySection = (sectionId: string) =>
    unscheduled.filter((p) => p.sectionId === sectionId)

  function addIdea() {
    const sectionId = activeSectionId || trip.planSections[0]?.id
    if (!sectionId || !draftName.trim()) return
    onChange(addPlanPlace(trip, { sectionId, name: draftName.trim() }))
    setDraftName('')
  }

  function applyPack(packId: string) {
    const pack = findRegionPack(packId)
    if (!pack) return
    let next = trip
    for (const p of pack.places) {
      let section = next.planSections.find(
        (s) => s.title.toLowerCase() === p.section.toLowerCase(),
      )
      if (!section) {
        section = {
          id: createId('SEC'),
          title: p.section,
          color: '#60a5fa',
          icon: '📍',
          order: next.planSections.length,
        }
        next = { ...next, planSections: [...next.planSections, section] }
      }
      next = addPlanPlace(next, {
        sectionId: section.id,
        name: p.name,
        city: p.city,
        lat: p.lat,
        lon: p.lon,
        notes: p.notes,
      })
    }
    onChange(next)
    setRail('lists')
    setTab('itinerary')
    setPacksOpen(false)
  }

  const dayPlaces =
    activeDay == null
      ? []
      : trip.planPlaces
          .filter((p) => p.scheduledDay === activeDay)
          .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))

  const legs = activeDay ? dayTravelLegs(trip, activeDay) : []
  const dayIdx = activeDay ? days.indexOf(activeDay) : -1
  const totalKm = legs.reduce((s, l) => s + (l?.km ?? 0), 0)
  const totalMin = legs.reduce((s, l) => s + (l?.minutes ?? 0), 0)

  return (
    <div className="plan-phone relative flex h-full min-h-0 flex-col">
      {/* Top chrome — clears the Journey/Plan switcher on the right */}
      <div className="plan-phone-top pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pt-[max(0.55rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex max-w-[calc(100%-9.5rem)] flex-col gap-2">
          <SegmentedControl
            ariaLabel="Plan view"
            value={tab}
            onChange={setTab}
            options={[
              { id: 'itinerary', label: 'Itinerary' },
              { id: 'map', label: 'Map' },
            ]}
          />
          <div className={`flex gap-1.5 pb-0.5 ${TOUCH_SCROLL_X}`}>
            {days.map((day, idx) => (
              <button
                key={day}
                type="button"
                className={`plan-day-chip shrink-0 ${railSafe === day ? 'plan-day-chip-on' : ''}`}
                onClick={() => setRail(day)}
              >
                Day {idx + 1}
              </button>
            ))}
            <button
              type="button"
              className={`plan-day-chip shrink-0 ${railSafe === 'lists' ? 'plan-day-chip-on' : ''}`}
              onClick={() => {
                setRail('lists')
                setTab('itinerary')
              }}
            >
              Lists
            </button>
          </div>
        </div>
      </div>

      {/* Map layer — only live while Map tab is open (saves GPU heat) */}
      <div
        className={`absolute inset-0 z-0 transition-opacity ${
          tab === 'map' ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden={tab !== 'map'}
      >
        {tab === 'map' ? (
          <PlanMapView
            meta={trip.meta}
            sections={trip.planSections}
            places={trip.planPlaces}
            visibleSectionIds={visibleSectionIds}
            visibleDays={mapVisibleDays}
            colorBy={railSafe === 'lists' ? 'section' : 'day'}
            focusPlaceId={focusPlaceId}
            className="h-full"
          />
        ) : null}
        {tab === 'map' && activeDay && dayPlaces.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)]/80 to-transparent pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-10">
            <div className={`pointer-events-auto flex gap-2 px-3 ${TOUCH_SCROLL_X}`}>
              {dayPlaces.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className="plan-map-stop shrink-0"
                  onClick={() => setFocusPlaceId(p.id)}
                >
                  <span className="plan-stop-num">{i + 1}</span>
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Itinerary / Lists — Wanderlog-style scroll sheet */}
      {tab === 'itinerary' ? (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col pt-[7.25rem]">
          <div
            className={`plan-itin-sheet mx-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[1.75rem] ${TOUCH_SCROLL_Y}`}
          >
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--ink-muted)]/35" />

            {railSafe === 'lists' ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                      Lists
                    </h2>
                    <p className="text-[12px] text-[var(--ink-muted)]">
                      Park ideas here, then add them to a day.
                    </p>
                  </div>
                  <Chip on={packsOpen} onClick={() => setPacksOpen((v) => !v)}>
                    Packs
                  </Chip>
                </div>

                {packsOpen ? (
                  <div className={`flex gap-1.5 ${TOUCH_SCROLL_X}`}>
                    {REGION_PACKS.map((pack) => (
                      <Chip key={pack.id} onClick={() => applyPack(pack.id)} title={pack.country}>
                        + {pack.label}
                      </Chip>
                    ))}
                  </div>
                ) : null}

                {trip.planSections.map((section) => (
                  <ListSection
                    key={section.id}
                    section={section}
                    places={bySection(section.id)}
                    active={activeSectionId === section.id}
                    days={days}
                    onSelect={() => setActiveSectionId(section.id)}
                    onFocus={setFocusPlaceId}
                    onSchedule={(placeId, day) => {
                      onChange(promotePlanPlaceToStep(trip, placeId, day))
                      setRail(day)
                    }}
                    onRemove={(placeId) => onChange(removePlanPlace(trip, placeId))}
                  />
                ))}

                <div className="plan-card">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                    Add to{' '}
                    {trip.planSections.find((s) => s.id === activeSectionId)?.title || 'list'}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addIdea()
                      }}
                      placeholder="Place name…"
                      className="plan-input"
                    />
                    <IconButton onClick={addIdea} disabled={!draftName.trim()}>
                      Add
                    </IconButton>
                  </div>
                </div>

                {onAskAi ? (
                  <div className="plan-card plan-card-ai">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300/90">
                      Ask Plan AI
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                        placeholder="e.g. fill Food for Provence…"
                        className="plan-input"
                      />
                      <IconButton
                        className="border-violet-400/40 text-violet-200"
                        onClick={() => {
                          if (!aiPrompt.trim()) return
                          onAskAi(aiPrompt.trim())
                          setAiPrompt('')
                        }}
                      >
                        Ask
                      </IconButton>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
                      Day {dayIdx + 1}
                    </h2>
                    <p className="text-[12px] text-[var(--ink-muted)]">
                      {activeDay}
                      {dayPlaces.length
                        ? ` · ${dayPlaces.length} stop${dayPlaces.length === 1 ? '' : 's'}`
                        : ''}
                      {totalKm > 0
                        ? ` · ${totalKm.toFixed(0)} km · ~${totalMin} min`
                        : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <IconButton
                      title="Show on map"
                      onClick={() => setTab('map')}
                    >
                      Map
                    </IconButton>
                    <IconButton
                      title="Optimize route"
                      disabled={dayPlaces.length < 2}
                      onClick={() =>
                        activeDay && onChange(optimizeDayRoute(trip, activeDay))
                      }
                    >
                      Optimize
                    </IconButton>
                  </div>
                </div>

                <div className={`min-h-0 flex-1 space-y-0 ${TOUCH_SCROLL_Y}`}>
                  {dayPlaces.map((p, i) => (
                    <div key={p.id}>
                      <div className="plan-stop-row">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          onClick={() => {
                            setFocusPlaceId(p.id)
                            setTab('map')
                          }}
                        >
                          <span className="plan-stop-num">{i + 1}</span>
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-[15px] font-medium text-[var(--ink)]">
                              {p.name}
                            </span>
                            {p.city ? (
                              <span className="block truncate text-[11px] text-[var(--ink-muted)]">
                                {p.city}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="shrink-0 px-1 text-[11px] font-semibold text-rose-300/90"
                          onClick={() => onChange(unschedulePlanPlace(trip, p.id))}
                        >
                          Remove
                        </button>
                      </div>
                      {legs[i] ? (
                        <div className="plan-leg">
                          <span className="plan-leg-line" />
                          <span>
                            {legs[i]!.km} km · ~{legs[i]!.minutes} min
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {!dayPlaces.length ? (
                    <div className="rounded-2xl border border-dashed border-[var(--glass-border)] px-4 py-10 text-center">
                      <p className="text-[15px] font-medium text-[var(--ink)]">
                        No stops yet
                      </p>
                      <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                        Pull ideas from Lists and schedule them on this day.
                      </p>
                      <button
                        type="button"
                        className="mt-4 rounded-full bg-[var(--coral)] px-4 py-2 text-xs font-semibold text-white"
                        onClick={() => setRail('lists')}
                      >
                        Open Lists
                      </button>
                    </div>
                  ) : null}
                </div>

                {unscheduled.length > 0 && activeDay ? (
                  <div className="mt-3 border-t border-[var(--glass-border)] pt-3">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">
                      Add from Lists
                    </p>
                    <div className={`flex gap-1.5 ${TOUCH_SCROLL_X}`}>
                      {unscheduled.slice(0, 12).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="plan-map-stop shrink-0"
                          onClick={() =>
                            onChange(promotePlanPlaceToStep(trip, p.id, activeDay))
                          }
                        >
                          + {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ListSection({
  section,
  places,
  active,
  days,
  onSelect,
  onFocus,
  onSchedule,
  onRemove,
}: {
  section: PlanSection
  places: PlanPlace[]
  active: boolean
  days: string[]
  onSelect: () => void
  onFocus: (id: string) => void
  onSchedule: (placeId: string, day: string) => void
  onRemove: (placeId: string) => void
}) {
  return (
    <section
      className={`plan-card ${active ? 'ring-1 ring-[var(--coral)]/45' : ''}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="mb-2 flex w-full items-center gap-2 text-left"
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full text-sm"
          style={{ background: `${section.color}33`, color: section.color }}
        >
          {section.icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--ink)]">
          {section.title}
        </span>
        <span className="text-[11px] text-[var(--ink-muted)]">{places.length}</span>
      </button>
      <div className="space-y-1.5">
        {places.map((p) => (
          <div key={p.id} className="plan-list-row">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--ink)]"
              onClick={() => onFocus(p.id)}
            >
              {p.name}
            </button>
            <select
              className="plan-day-select"
              defaultValue=""
              aria-label={`Schedule ${p.name}`}
              onChange={(e) => {
                if (e.target.value) onSchedule(p.id, e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">Day…</option>
              {days.map((d, i) => (
                <option key={d} value={d}>
                  D{i + 1}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="px-1 text-[11px] text-rose-300/90"
              onClick={() => onRemove(p.id)}
            >
              ✕
            </button>
          </div>
        ))}
        {!places.length ? (
          <p className="px-1 py-2 text-[12px] text-[var(--ink-muted)]">
            Empty — add a place or open Packs
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Local Plan AI: parse simple intents into places (no network). */
export function applyLocalPlanAi(
  trip: TripRecord,
  prompt: string,
): { trip: TripRecord; message: string } {
  const q = prompt.toLowerCase()
  if (q.includes('provence') || q.includes('france')) {
    const pack = findRegionPack('provence')
    if (pack) {
      let next = trip
      for (const p of pack.places) {
        if (q.includes('food') && p.section !== 'Food') continue
        if (q.includes('must') && p.section !== 'Must see') continue
        let section = next.planSections.find(
          (s) => s.title.toLowerCase() === p.section.toLowerCase(),
        )
        if (!section) {
          section = {
            id: createId('SEC'),
            title: p.section,
            color: '#60a5fa',
            icon: '📍',
            order: next.planSections.length,
          }
          next = { ...next, planSections: [...next.planSections, section] }
        }
        next = addPlanPlace(next, {
          sectionId: section.id,
          name: p.name,
          city: p.city,
          lat: p.lat,
          lon: p.lon,
          notes: p.notes,
        })
      }
      return { trip: next, message: `Added ideas from ${pack.label}.` }
    }
  }
  if (q.includes('tuscany') || q.includes('italy')) {
    const pack = findRegionPack('tuscany')
    if (pack) {
      let next = trip
      for (const p of pack.places) {
        let section = next.planSections.find(
          (s) => s.title.toLowerCase() === p.section.toLowerCase(),
        )
        if (!section) {
          section = {
            id: createId('SEC'),
            title: p.section,
            color: '#34d399',
            icon: '📍',
            order: next.planSections.length,
          }
          next = { ...next, planSections: [...next.planSections, section] }
        }
        next = addPlanPlace(next, {
          sectionId: section.id,
          name: p.name,
          city: p.city,
          lat: p.lat,
          lon: p.lon,
          notes: p.notes,
        })
      }
      return { trip: next, message: `Added ideas from ${pack.label}.` }
    }
  }
  return {
    trip,
    message: 'Try “fill Food for Provence” or “Tuscany starters”.',
  }
}
