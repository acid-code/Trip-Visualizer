import * as XLSX from 'xlsx'
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  type ItemStatus,
  type ItemType,
  type TripItem,
  type TripMeta,
} from '../domain/types'
import { createId, sortItems } from './db'
import { normalizeCurrency } from './fx'
import { MAX_SCHEDULE_ROWS } from './security'
import { parseLat, parseLon, sanitizeEndDate } from './validate'
import { sanitizeTripItem, sanitizeTripMeta } from '../domain/types'

const HEADER_ALIASES: Record<string, string> = {
  id: 'id',
  date: 'date',
  end_date: 'end_date',
  enddate: 'end_date',
  check_in: 'date',
  checkin: 'date',
  check_out: 'end_date',
  checkout: 'end_date',
  start: 'start',
  end: 'end',
  type: 'type',
  title: 'title',
  hotel: 'title',
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

const TYPE_SYNONYMS: Record<string, ItemType> = {
  food: 'restaurant',
  meal: 'restaurant',
  meals: 'restaurant',
  cafe: 'restaurant',
  coffee: 'restaurant',
  sightseeing: 'sight',
  sights: 'sight',
  museum: 'sight',
  attraction: 'sight',
  car: 'drive',
  driving: 'drive',
  road: 'drive',
  lodging: 'hotel',
  accommodation: 'hotel',
  stay: 'hotel',
  drink: 'restaurant',
  drinks: 'restaurant',
  nature: 'activity',
  park: 'activity',
  walk: 'activity',
  hiking: 'activity',
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/\*+/g, '')
    .replace(/[·•].*$/, '') // drop " · format" if pasted into header
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function parseTags(value: unknown): string[] {
  if (!value) return []
  return String(value)
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isoFromYmd(y: number, m: number, d: number): string {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ''
  if (m < 1 || m > 12 || d < 1 || d > 31) return ''
  const s = `${y}-${pad2(m)}-${pad2(d)}`
  const dt = new Date(s + 'T12:00:00')
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== s) return ''
  return s
}

/** Lenient date → YYYY-MM-DD (preferred ISO; falls back to common user formats). */
function excelDateToIso(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) return isoFromYmd(parsed.y, parsed.m, parsed.d)
  }

  const s = String(value).trim()
  if (!s) return ''

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isoFromYmd(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)))
  }

  // YYYY/MM/DD
  let m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/)
  if (m) return isoFromYmd(Number(m[1]), Number(m[2]), Number(m[3]))

  // D/M/Y or M/D/Y
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) {
    let a = Number(m[1])
    let b = Number(m[2])
    let y = Number(m[3])
    if (y < 100) y += y >= 70 ? 1900 : 2000
    if (a > 12 && b <= 12) return isoFromYmd(y, b, a) // DMY
    if (b > 12 && a <= 12) return isoFromYmd(y, a, b) // MDY
    // ambiguous — try DMY then MDY
    return isoFromYmd(y, b, a) || isoFromYmd(y, a, b)
  }

  const dt = new Date(s)
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return ''
}

/** Lenient time → HH:MM. */
function excelTimeToHm(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel time fraction (or datetime serial — use fractional day)
    let frac = value
    if (value >= 1) frac = value % 1
    const totalMinutes = Math.round(frac * 24 * 60)
    const hh = Math.floor(totalMinutes / 60) % 24
    const mm = totalMinutes % 60
    return `${pad2(hh)}:${pad2(mm)}`
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`
  }

  const s = String(value).trim()
  if (!s) return ''

  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return ''
    return `${pad2(h)}:${pad2(min)}`
  }

  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\.?$/i)
  if (m) {
    let h = Number(m[1])
    const min = Number(m[2] || 0)
    const ap = m[3]!.toLowerCase()
    if (min > 59 || h < 1 || h > 12) return ''
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    return `${pad2(h)}:${pad2(min)}`
  }

  return ''
}

function parseCostLoose(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value < 0 ? null : value
  const s = String(value)
    .trim()
    .replace(/\s/g, '')
    .replace(/[€$£¥₪]/g, '')
    .replace(/,/g, '.')
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function normalizeCurrencyLoose(value: unknown, fallback: string): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return normalizeCurrency(fallback)
  if (raw === 'euro' || raw === 'euros' || raw === '€') return 'EUR'
  if (raw === 'dollar' || raw === 'dollars' || raw === 'usd' || raw === '$') return 'USD'
  if (raw === 'pound' || raw === 'pounds' || raw === 'gbp' || raw === '£') return 'GBP'
  if (raw === 'shekel' || raw === 'shekels' || raw === 'ils' || raw === 'nis') return 'ILS'
  return normalizeCurrency(raw.toUpperCase(), fallback)
}

function asType(value: unknown): ItemType {
  const t = String(value ?? 'other')
    .trim()
    .toLowerCase()
  if ((ITEM_TYPES as readonly string[]).includes(t)) return t as ItemType
  if (TYPE_SYNONYMS[t]) return TYPE_SYNONYMS[t]!
  return 'other'
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

function isHintRow(row: Record<string, unknown>): boolean {
  const blob = Object.values(row)
    .map((v) => String(v ?? '').toLowerCase())
    .join(' ')
  if (!blob.trim()) return true
  const looksLikeHint =
    /\brequired\b/.test(blob) ||
    /\boptional\b/.test(blob) ||
    /\byyyy\b/.test(blob) ||
    /\bhh:mm\b/.test(blob) ||
    /\bpreferred\b/.test(blob)
  if (!looksLikeHint) return false
  // Hint rows usually have no real title/date combo
  const title = String(row.title ?? '').trim()
  const date = excelDateToIso(row.date)
  if (title && date && !/required|optional|yyyy|hh:mm/i.test(title)) return false
  return true
}

function mapRawRow(raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const nk = HEADER_ALIASES[normalizeHeader(k)]
    if (nk) row[nk] = v
  }
  return row
}

function rowToItem(
  row: Record<string, unknown>,
  meta: TripMeta,
  forceType?: ItemType,
): TripItem | null {
  const title = String(row.title ?? '').trim()
  const date = excelDateToIso(row.date)
  if (!title && !date) return null
  if (isHintRow(row)) return null

  const rowDate = date || meta.startDate
  if (!rowDate) return null

  const type = forceType ?? asType(row.type)
  const rowEnd = sanitizeEndDate(rowDate, excelDateToIso(row.end_date))
  const cost = parseCostLoose(row.cost)

  try {
    return sanitizeTripItem({
      id: String(row.id || '').trim() || createId('X'),
      type,
      title: title || 'Untitled',
      place: String(row.place ?? ''),
      city: String(row.city ?? ''),
      date: rowDate,
      endDate: type === 'hotel' ? rowEnd || rowDate : rowEnd,
      start: type === 'hotel' ? '' : excelTimeToHm(row.start),
      end: type === 'hotel' ? '' : excelTimeToHm(row.end),
      from: String(row.from ?? ''),
      to: String(row.to ?? ''),
      confirm: String(row.confirm ?? ''),
      cost,
      currency: normalizeCurrencyLoose(row.currency, meta.homeCurrency),
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
    })
  } catch {
    return null
  }
}

/** Find the header row (Date/Type/Title or Check-in/Hotel) so title/legend rows above tables still import. */
function findHeaderRowIndex(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const row = aoa[i] ?? []
    const mapped = new Set(
      row
        .map((c) => HEADER_ALIASES[normalizeHeader(c)])
        .filter((k): k is string => Boolean(k)),
    )
    const hasDate = mapped.has('date')
    const hasTitle = mapped.has('title')
    const hasType = mapped.has('type')
    // Steps: Date + Type + Title · Hotels: Check-in (+ Hotel as title) · legacy Schedule
    if (hasDate && hasTitle && (hasType || mapped.has('end_date') || mapped.size >= 5)) {
      return i
    }
  }
  return 0
}

function parseSheetRows(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
  })
  if (!aoa.length) return []
  const headerIdx = findHeaderRowIndex(aoa)
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    range: headerIdx,
    defval: '',
    raw: true,
  })
}

function parseMetaFromTripSheet(tripSheet: XLSX.WorkSheet | undefined): TripMeta {
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
      if (!key || key === 'key' || key.startsWith('how_to') || key.startsWith('—')) continue
      // Stop at how-to blurb
      if (key.includes('fill_the') || key === 'howto' || key === 'how_to_use') break
      metaMap[key] = String(row[1] ?? '').trim()
    }
  }

  const startDate =
    excelDateToIso(metaMap.start_date) || new Date().toISOString().slice(0, 10)
  let endDate = excelDateToIso(metaMap.end_date) || startDate
  if (endDate < startDate) endDate = startDate

  return sanitizeTripMeta({
    name: (metaMap.name || 'Imported trip').trim() || 'Imported trip',
    startDate,
    endDate,
    homeCurrency: normalizeCurrencyLoose(metaMap.home_currency || 'EUR', 'EUR'),
    timezoneNote: metaMap.timezone_note || 'All times are local',
    travelers: metaMap.travelers || '',
    notes: metaMap.notes || '',
  })
}

function parseLegacySchedule(
  scheduleSheet: XLSX.WorkSheet,
  meta: TripMeta,
): TripItem[] {
  const rawRows = parseSheetRows(scheduleSheet)
  if (rawRows.length > MAX_SCHEDULE_ROWS) throw new Error('Schedule too large')

  const items: TripItem[] = []
  for (const raw of rawRows) {
    const row = mapRawRow(raw)
    const item = rowToItem(row, meta)
    if (item) items.push(item)
  }
  return items
}

function parseV2Sheets(
  wb: XLSX.WorkBook,
  meta: TripMeta,
): TripItem[] {
  const items: TripItem[] = []
  const stepsSheet = findSheet(wb, 'Steps')
  const hotelsSheet = findSheet(wb, 'Hotels')

  if (stepsSheet) {
    for (const raw of parseSheetRows(stepsSheet)) {
      const row = mapRawRow(raw)
      const item = rowToItem(row, meta)
      if (!item) continue
      // Hotel typed on Steps by mistake still OK
      items.push(item)
    }
  }

  if (hotelsSheet) {
    for (const raw of parseSheetRows(hotelsSheet)) {
      const row = mapRawRow(raw)
      const item = rowToItem(row, meta, 'hotel')
      if (item) items.push(item)
    }
  }

  if (items.length > MAX_SCHEDULE_ROWS) throw new Error('Schedule too large')
  return items
}

export function parseTripWorkbook(data: ArrayBuffer): {
  meta: TripMeta
  items: TripItem[]
} {
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
  if (bytes.byteLength < 64) {
    throw new Error('File is empty or corrupt — re-save the Excel from the app / Drive')
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      'Not a valid .xlsx workbook (Drive may have converted it). Save again after the latest update.',
    )
  }

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
  const tripSheet = findSheet(wb, 'Trip')
  const meta = parseMetaFromTripSheet(tripSheet)

  const stepsSheet = findSheet(wb, 'Steps')
  const hotelsSheet = findSheet(wb, 'Hotels')
  const scheduleSheet = findSheet(wb, 'Schedule')

  let items: TripItem[]
  if (stepsSheet || hotelsSheet) {
    items = parseV2Sheets(wb, meta)
  } else if (scheduleSheet) {
    items = parseLegacySchedule(scheduleSheet, meta)
  } else {
    const names = (wb.SheetNames || []).join(', ') || '(none)'
    throw new Error(`Missing Steps or Schedule sheet (found: ${names})`)
  }

  return {
    meta,
    items: sortItems(items),
  }
}

export {
  buildTripWorkbook,
  downloadWorkbook,
  tripToBlankTemplate,
  workbookToArrayBuffer,
} from './excelExport'
