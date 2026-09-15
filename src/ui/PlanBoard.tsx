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
  phone?: boolean
  onChange: (next: TripRecord) => void
  onAskAi?: (prompt: string) => void
}

export function PlanBoard({ trip, phone, onChange, onAskAi }: Props) {
  const days = listTripDays(trip.meta)
  const [activeSectionId, setActiveSectionId] = useState(
    trip.planSections[0]?.id ?? '',
  )
  const [layerMode, setLayerMode] = useState<'sections' | 'days'>('sections')
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(new Set())
  const [hiddenDays, setHiddenDays] = useState<Set<string>>(new Set())
  const [focusPlaceId, setFocusPlaceId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')

  const visibleSectionIds = useMemo(() => {
    const ids = new Set(trip.planSections.map((s) => s.id))
    for (const id of hiddenSections) ids.delete(id)
    return ids
  }, [trip.planSections, hiddenSections])

  const visibleDays = useMemo(() => {
    if (layerMode !== 'days') return null
    const ids = new Set(days)
    for (const id of hiddenDays) ids.delete(id)
    return ids
  }, [layerMode, days, hiddenDays])

  function toggleSection(id: string) {
    setHiddenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleDay(day: string) {
    setHiddenDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

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
  }

  const unscheduled = trip.planPlaces.filter((p) => !p.scheduledDay)
  const bySection = (sectionId: string) =>
    unscheduled.filter((p) => p.sectionId === sectionId)

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${phone ? 'px-2 pb-2 pt-2' : 'p-2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--teal)]">
          Plan
        </div>
        <SegmentedControl
          ariaLabel="Map layers"
          value={layerMode}
          onChange={setLayerMode}
          options={[
            { id: 'sections', label: 'Sections' },
            { id: 'days', label: 'Days' },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-1">
          {REGION_PACKS.map((pack) => (
            <Chip key={pack.id} onClick={() => applyPack(pack.id)} title={pack.country}>
              + {pack.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 gap-2 ${phone ? 'flex-col' : 'flex-row'}`}>
        <div
          className={`flex min-h-0 flex-col gap-2 ${phone ? 'max-h-[42%] shrink-0' : 'w-[42%]'} ${TOUCH_SCROLL_Y}`}
        >
          {trip.planSections.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              places={bySection(section.id)}
              active={activeSectionId === section.id}
              hidden={!visibleSectionIds.has(section.id)}
              days={days}
              onSelect={() => setActiveSectionId(section.id)}
              onToggleLayer={() => toggleSection(section.id)}
              onFocus={setFocusPlaceId}
              onSchedule={(placeId, day) =>
                onChange(promotePlanPlaceToStep(trip, placeId, day))
              }
              onRemove={(placeId) => onChange(removePlanPlace(trip, placeId))}
            />
          ))}

          <div className="rounded-2xl border border-[var(--glass-border)] bg-[rgba(15,23,42,0.55)] p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Add idea to {trip.planSections.find((s) => s.id === activeSectionId)?.title || '…'}
            </div>
            <div className="flex gap-1.5">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addIdea()
                }}
                placeholder="Place name…"
                className="min-w-0 flex-1 rounded-xl border border-[var(--glass-border)] bg-[rgba(15,23,42,0.8)] px-2.5 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--coral)]"
              />
              <IconButton onClick={addIdea} disabled={!draftName.trim()}>
                Add
              </IconButton>
            </div>
          </div>

          <div className="rounded-2xl border border-violet-500/30 bg-violet-950/30 p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
              Plan AI
            </div>
            <div className="flex gap-1.5">
              <input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="e.g. fill Food for Provence…"
                className="min-w-0 flex-1 rounded-xl border border-violet-400/30 bg-[rgba(15,23,42,0.8)] px-2.5 py-2 text-sm text-[var(--ink)] outline-none"
              />
              <IconButton
                className="border-violet-400/40 text-violet-200"
                onClick={() => {
                  if (!aiPrompt.trim() || !onAskAi) return
                  onAskAi(aiPrompt.trim())
                  setAiPrompt('')
                }}
              >
                Ask
              </IconButton>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <PlanMapView
            meta={trip.meta}
            sections={trip.planSections}
            places={trip.planPlaces}
            visibleSectionIds={visibleSectionIds}
            visibleDays={visibleDays}
            colorBy={layerMode === 'days' ? 'day' : 'section'}
            focusPlaceId={focusPlaceId}
            className={phone ? 'min-h-[10rem]' : ''}
          />

          <div className={`flex gap-2 pb-1 ${TOUCH_SCROLL_X}`}>
            {days.map((day, idx) => {
              const dayPlaces = trip.planPlaces
                .filter((p) => p.scheduledDay === day)
                .sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0))
              const legs = dayTravelLegs(trip, day)
              const dayHidden = hiddenDays.has(day)
              return (
                <div
                  key={day}
                  className={`w-[11.5rem] shrink-0 rounded-2xl border p-2 ${
                    dayHidden
                      ? 'border-[var(--glass-border)] opacity-40'
                      : 'border-sky-500/35 bg-sky-950/25'
                  }`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const placeId = e.dataTransfer.getData('text/plan-place')
                    if (placeId) onChange(promotePlanPlaceToStep(trip, placeId, day))
                  }}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-1">
                    <button
                      type="button"
                      className="text-[11px] font-bold text-sky-200"
                      onClick={() => toggleDay(day)}
                    >
                      Day {idx + 1}
                    </button>
                    <IconButton
                      title="Optimize route"
                      onClick={() => onChange(optimizeDayRoute(trip, day))}
                    >
                      ↻
                    </IconButton>
                  </div>
                  <p className="mb-1.5 text-[10px] text-[var(--ink-muted)]">{day.slice(5)}</p>
                  <div className="space-y-1">
                    {dayPlaces.map((p, i) => (
                      <div key={p.id}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) =>
                            e.dataTransfer.setData('text/plan-place', p.id)
                          }
                          onClick={() => setFocusPlaceId(p.id)}
                          className="w-full rounded-xl border border-[var(--glass-border)] bg-[rgba(15,23,42,0.7)] px-2 py-1.5 text-left text-[11px] font-medium"
                        >
                          {p.name}
                        </button>
                        {legs[i] ? (
                          <p className="px-1 py-0.5 text-[9px] text-[var(--ink-muted)]">
                            → {legs[i]!.km} km · ~{legs[i]!.minutes} min
                          </p>
                        ) : null}
                      </div>
                    ))}
                    {!dayPlaces.length ? (
                      <p className="rounded-xl border border-dashed border-[var(--glass-border)] px-2 py-3 text-center text-[10px] text-[var(--ink-muted)]">
                        Drop ideas here
                      </p>
                    ) : null}
                  </div>
                  {dayPlaces.length ? (
                    <button
                      type="button"
                      className="mt-1.5 text-[10px] font-semibold text-rose-300"
                      onClick={() => {
                        let next = trip
                        for (const p of dayPlaces) next = unschedulePlanPlace(next, p.id)
                        onChange(next)
                      }}
                    >
                      Clear day slots
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionBlock({
  section,
  places,
  active,
  hidden,
  days,
  onSelect,
  onToggleLayer,
  onFocus,
  onSchedule,
  onRemove,
}: {
  section: PlanSection
  places: PlanPlace[]
  active: boolean
  hidden: boolean
  days: string[]
  onSelect: () => void
  onToggleLayer: () => void
  onFocus: (id: string) => void
  onSchedule: (placeId: string, day: string) => void
  onRemove: (placeId: string) => void
}) {
  return (
    <div
      className={`rounded-2xl border p-2 ${
        active ? 'border-[var(--coral)]/50 bg-[rgba(255,107,74,0.08)]' : 'border-[var(--glass-border)]'
      } ${hidden ? 'opacity-45' : ''}`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-xs"
            style={{ background: `${section.color}33`, color: section.color }}
          >
            {section.icon}
          </span>
          <span className="truncate text-sm font-semibold">{section.title}</span>
          <span className="text-[10px] text-[var(--ink-muted)]">{places.length}</span>
        </button>
        <Chip on={!hidden} onClick={onToggleLayer}>
          layer
        </Chip>
      </div>
      <div className="space-y-1">
        {places.map((p) => (
          <div
            key={p.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plan-place', p.id)}
            className="flex items-center gap-1 rounded-xl border border-[var(--glass-border)] bg-[rgba(15,23,42,0.55)] px-2 py-1.5"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-xs font-medium"
              onClick={() => onFocus(p.id)}
            >
              {p.name}
            </button>
            <select
              className="max-w-[5.5rem] rounded-lg border border-[var(--glass-border)] bg-transparent px-1 py-0.5 text-[10px]"
              defaultValue=""
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
              className="text-[10px] text-rose-300"
              onClick={() => onRemove(p.id)}
            >
              ✕
            </button>
          </div>
        ))}
        {!places.length ? (
          <p className="px-1 py-2 text-[10px] text-[var(--ink-muted)]">Empty — add ideas or a region pack</p>
        ) : null}
      </div>
    </div>
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
      // reuse PlanBoard pack logic inline
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
