import * as XLSX from 'xlsx'
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  SCHEDULE_HEADERS,
  type ItemStatus,
  type ItemType,
  type TripItem,
  type TripMeta,
  type TripRecord,
} from '../domain/types'
import { createId, nowIso, sortItems } from './db'
import { normalizeCurrency } from './fx'
import { MAX_SCHEDULE_ROWS } from './security'
import { parseLat, parseLon, parseNonNegativeNumber, sanitizeEndDate } from './validate'
import { sanitizeTripItem, sanitizeTripMeta } from '../domain/types'

const HEADER_ALIASES: Record<string, string> = {
  id: 'id',
  date: 'date',
  end_date: 'end_date',
  enddate: 'end_date',
  start: 'start',
  end: 'end',
  type: 'type',
  title: 'title',
  place: 'place',
  city: 'city',
  from: 'from',
  to: 'to',
  confirm: 'confirm',
  confirmation: 'confirm',
  cost: 'cost',
  currency: 'currency',
  status: 'status',
  notes: 'notes',
  url: 'url',
  tags: 'tags',
  lat: 'lat',
  lon: 'lon',
  lng: 'lon',
  longitude: 'lon',
  latitude: 'lat',
  lat_to: 'lat_to',
  lon_to: 'lon_to',
  wikidata: 'wikidata',
  osm_id: 'osm_id',
  geocode_query: 'geocode_query',
  updated_at: 'updated_at',
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function parseTags(value: unknown): string[] {
  if (!value) return []
  return String(value)
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function excelDateToIso(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return ''
    const m = String(parsed.m).padStart(2, '0')
    const d = String(parsed.d).padStart(2, '0')
    return `${parsed.y}-${m}-${d}`
  }
  const s = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = new Date(s + 'T12:00:00')
    if (!Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s) return s
    return ''
  }
  const dt = new Date(s)
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return ''
}

function excelTimeToHm(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const totalMinutes = Math.round(value * 24 * 60)
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0')
    const mm = String(totalMinutes % 60).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const s = String(value).trim()
  const m = s.match(/^(\d{1,2}):(\d{2})/)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return ''
    return `${m[1].padStart(2, '0')}:${m[2]}`
  }
  return ''
}

function asType(value: unknown): ItemType {
  const t = String(value ?? 'other').trim().toLowerCase()
  return (ITEM_TYPES as readonly string[]).includes(t) ? (t as ItemType) : 'other'
}

function asStatus(value: unknown): ItemStatus {
  const t = String(value ?? 'planned').trim().toLowerCase()
  return (ITEM_STATUSES as readonly string[]).includes(t)
    ? (t as ItemStatus)
    : 'planned'
}

function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | undefined {
  const want = name.trim().toLowerCase()
  const key =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === want) ||
    Object.keys(wb.Sheets).find((n) => n.trim().toLowerCase() === want)
  return key ? wb.Sheets[key] : undefined
}

export function parseTripWorkbook(data: ArrayBuffer): {
  meta: TripMeta
  items: TripItem[]
} {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
  if (bytes.byteLength < 64) {
    throw new Error('File is empty or corrupt — re-save the Excel from the app / Drive')
  }
  // ZIP/xlsx files start with PK
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      'Not a valid .xlsx workbook (Drive may have converted it). Save again after the latest update.',
    )
  }

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
  const scheduleSheet = findSheet(wb, 'Schedule')
  if (!scheduleSheet) {
    const names = (wb.SheetNames || []).join(', ') || '(none)'
    throw new Error(`Missing Schedule sheet (found: ${names})`)
  }
  const tripSheet = findSheet(wb, 'Trip')

  const metaMap: Record<string, string> = {}
  if (tripSheet) {
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(tripSheet, {
      header: 1,
      defval: '',
    })
    for (const row of rows) {
      const key = String(row[0] ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
      if (!key) continue
      metaMap[key] = String(row[1] ?? '').trim()
    }
  }

  const startDate =
    excelDateToIso(metaMap.start_date) || new Date().toISOString().slice(0, 10)
  let endDate = excelDateToIso(metaMap.end_date) || startDate
  if (endDate < startDate) endDate = startDate

  const meta: TripMeta = {
    name: (metaMap.name || 'Imported trip').trim() || 'Imported trip',
    startDate,
    endDate,
    homeCurrency: normalizeCurrency(metaMap.home_currency || 'EUR'),
    timezoneNote: metaMap.timezone_note || 'All times are local',
    travelers: metaMap.travelers || '',
    notes: metaMap.notes || '',
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(scheduleSheet, {
    defval: '',
  })
  if (rawRows.length > MAX_SCHEDULE_ROWS) {
    throw new Error('Schedule too large')
  }

  const items: TripItem[] = []

  for (const raw of rawRows) {
    const row: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      const nk = HEADER_ALIASES[normalizeHeader(k)]
      if (nk) row[nk] = v
    }
    const title = String(row.title ?? '').trim()
    const date = excelDateToIso(row.date)
    if (!title && !date) continue

    const rowDate = date || meta.startDate
    const rowEnd = sanitizeEndDate(rowDate, excelDateToIso(row.end_date))
    const cost = parseNonNegativeNumber(row.cost)

    try {
      items.push(
        sanitizeTripItem({
          id: String(row.id || '').trim() || createId('X'),
          type: asType(row.type),
          title: title || 'Untitled',
          place: String(row.place ?? ''),
          city: String(row.city ?? ''),
          date: rowDate,
          endDate: rowEnd,
          start: excelTimeToHm(row.start),
          end: excelTimeToHm(row.end),
          from: String(row.from ?? ''),
          to: String(row.to ?? ''),
          confirm: String(row.confirm ?? ''),
          cost,
          currency: normalizeCurrency(String(row.currency ?? meta.homeCurrency)),
          status: asStatus(row.status),
          notes: String(row.notes ?? ''),
          url: String(row.url ?? ''),
          tags: parseTags(row.tags),
          lat: parseLat(row.lat),
          lon: parseLon(row.lon),
          latTo: parseLat(row.lat_to),
          lonTo: parseLon(row.lon_to),
          wikidata: String(row.wikidata ?? ''),
          osmId: String(row.osm_id ?? ''),
          geocodeQuery: String(row.geocode_query ?? ''),
          updatedAt: String(row.updated_at ?? ''),
          enrichmentSummary: '',
          enrichmentImage: '',
          enrichmentSource: '',
          routeCoords: [],
          source: 'excel',
        }),
      )
    } catch {
      // skip invalid rows (allowlist)
    }
  }

  return {
    meta: sanitizeTripMeta(meta),
    items: sortItems(items),
  }
}

function itemToRow(item: TripItem): Record<string, string | number | null> {
  return {
    id: item.id,
    date: item.date,
    end_date: item.endDate || '',
    start: item.start || '',
    end: item.end || '',
    type: item.type,
    title: item.title,
    place: item.place || '',
    city: item.city || '',
    from: item.from || '',
    to: item.to || '',
    confirm: item.confirm || '',
    cost: item.cost,
    currency: item.currency || '',
    status: item.status,
    notes: item.notes || '',
    url: item.url || '',
    tags: item.tags.join('; '),
    lat: item.lat,
    lon: item.lon,
    lat_to: item.latTo,
    lon_to: item.lonTo,
    wikidata: item.wikidata || '',
    osm_id: item.osmId || '',
    geocode_query: item.geocodeQuery || '',
    updated_at: item.updatedAt || nowIso(),
  }
}

export function buildTripWorkbook(trip: TripRecord): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()

  const tripAoA = [
    ['key', 'value'],
    ['name', trip.meta.name],
    ['start_date', trip.meta.startDate],
    ['end_date', trip.meta.endDate],
    ['home_currency', trip.meta.homeCurrency],
    ['timezone_note', trip.meta.timezoneNote],
    ['travelers', trip.meta.travelers],
    ['notes', trip.meta.notes],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tripAoA), 'Trip')

  const rows = sortItems(trip.items).map(itemToRow)
  const schedule = XLSX.utils.json_to_sheet(rows, {
    header: [...SCHEDULE_HEADERS],
  })
  XLSX.utils.book_append_sheet(wb, schedule, 'Schedule')

  const legend = XLSX.utils.aoa_to_sheet([
    ['Column / Value', 'Meaning'],
    ['Schedule sheet', 'One row per event in chronological order — the sheet you keep up with'],
    ['type values', ITEM_TYPES.join(', ')],
    ['status values', ITEM_STATUSES.join(', ')],
    ['from / to', 'For flights use IATA (TLV, CDG). For drives use place names'],
    ['end_date', 'Hotel checkout or overnight flight/train arrival date'],
    ['lat / lon', 'Optional; app fills on enrich/export'],
    ['All times', 'Local wall clock — never UTC in this workbook'],
  ])
  XLSX.utils.book_append_sheet(wb, legend, 'Legend')
  return wb
}

export function downloadWorkbook(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename)
}

/** Binary for Drive upload / programmatic import (same bytes as a downloaded .xlsx). */
export function workbookToArrayBuffer(wb: XLSX.WorkBook): ArrayBuffer {
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array
  const copy = new Uint8Array(out.byteLength)
  copy.set(out)
  return copy.buffer
}

export function tripToBlankTemplate(): XLSX.WorkBook {
  const blank: TripRecord = {
    id: 'template',
    isExample: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    meta: {
      name: 'My trip',
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      homeCurrency: 'EUR',
      timezoneNote: 'All times are local',
      travelers: '',
      notes: 'Fill Schedule rows. Download from the app after edits for round-trip.',
    },
    items: [
      {
        id: 'F01',
        type: 'flight',
        title: 'Example flight',
        place: '',
        city: '',
        date: '2026-10-01',
        endDate: '',
        start: '10:00',
        end: '13:00',
        from: 'TLV',
        to: 'CDG',
        confirm: '',
        cost: null,
        currency: 'EUR',
        status: 'planned',
        notes: 'Replace with your flight',
        url: '',
        tags: [],
        lat: null,
        lon: null,
        latTo: null,
        lonTo: null,
        wikidata: '',
        osmId: '',
        geocodeQuery: '',
        updatedAt: '',
        enrichmentSummary: '',
        enrichmentImage: '',
        enrichmentSource: '',
        routeCoords: [],
        source: 'excel',
      },
      {
        id: 'H01',
        type: 'hotel',
        title: 'Example hotel',
        place: 'Hotel name',
        city: 'Paris',
        date: '2026-10-01',
        endDate: '2026-10-03',
        start: '15:00',
        end: '11:00',
        from: '',
        to: '',
        confirm: '',
        cost: null,
        currency: 'EUR',
        status: 'planned',
        notes: '2 nights example',
        url: '',
        tags: [],
        lat: null,
        lon: null,
        latTo: null,
        lonTo: null,
        wikidata: '',
        osmId: '',
        geocodeQuery: '',
        updatedAt: '',
        enrichmentSummary: '',
        enrichmentImage: '',
        enrichmentSource: '',
        routeCoords: [],
        source: 'excel',
      },
    ],
  }
  return buildTripWorkbook(blank)
}
