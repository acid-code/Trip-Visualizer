import ExcelJS from 'exceljs'
import { ITEM_TYPES, TYPE_COLORS, type ItemType, type TripItem, type TripRecord } from '../domain/types'
import { dayColor } from './dayTheme'
import { nowIso, sortItems } from './db'
import { normalizeCurrency } from './fx'
import { tripDays } from './analytics'

/** Human Steps sheet columns (export order). */
export const STEPS_COLS = [
  'Date',
  'Start',
  'End',
  'Type',
  'Title',
  'Place',
  'City',
  'From',
  'To',
  'Confirm',
  'Cost',
  'Currency',
  'Status',
  'Notes',
  'URL',
  'Tags',
  'Lat',
  'Lon',
  'Lat to',
  'Lon to',
] as const

export const STEPS_HINTS = [
  'Required · YYYY-MM-DD',
  'Optional · HH:MM (24h)',
  'Optional · HH:MM (24h)',
  'Required · flight, train, bus, ferry, drive, sight, restaurant, activity, city, note, other',
  'Required · free text',
  'Optional · free text',
  'Optional · free text',
  'Optional · place or IATA',
  'Optional · place or IATA',
  'Optional · booking ref',
  'Optional · number ≥ 0',
  'Optional · 3-letter code (EUR)',
  'Optional · planned / booked / done / cancelled',
  'Optional · free text',
  'Optional · https://…',
  'Optional · comma-separated',
  'Optional · decimal degrees',
  'Optional · decimal degrees',
  'Optional · decimal degrees',
  'Optional · decimal degrees',
] as const

export const HOTELS_COLS = [
  'Check-in',
  'Check-out',
  'Hotel',
  'Place',
  'City',
  'Confirm',
  'Cost',
  'Currency',
  'Status',
  'Notes',
  'URL',
  'Lat',
  'Lon',
] as const

export const HOTELS_HINTS = [
  'Required · YYYY-MM-DD',
  'Preferred · YYYY-MM-DD (defaults to check-in)',
  'Required · free text',
  'Optional · free text',
  'Optional · free text',
  'Optional · booking ref',
  'Optional · number ≥ 0',
  'Optional · 3-letter code (EUR)',
  'Optional · planned / booked / done / cancelled',
  'Optional · free text',
  'Optional · https://…',
  'Optional · decimal degrees',
  'Optional · decimal degrees',
] as const

const BRAND = 'FFFF6B4A'
const INK = 'FF0F172A'
const MUTED = 'FF64748B'
const PAPER = 'FFFFFBF8'
const SOFT = 'FFFFF1EB'
const WHITE = 'FFFFFFFF'
const HEADER_FILL = 'FF1E293B'
const BAR_MAX = 12

const STATUS_FILL: Record<string, string> = {
  planned: 'FFF1F5F9',
  booked: 'FFDBEAFE',
  done: 'FFDCFCE7',
  cancelled: 'FFFEE2E2',
}

function isPlaceholderItem(item: TripItem): boolean {
  return item.tags?.includes('placeholder') === true
}

function tagsJoined(item: TripItem): string {
  return item.tags.filter((t) => t !== 'placeholder').join(', ')
}

function argb(hex: string): string {
  const h = hex.replace('#', '').toUpperCase()
  return h.length === 6 ? `FF${h}` : h.length === 8 ? h : 'FF94A3B8'
}

function mixHex(hex: string, whiteAmt: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const t = Math.min(1, Math.max(0, whiteAmt))
  const mr = Math.round(r + (255 - r) * t)
  const mg = Math.round(g + (255 - g) * t)
  const mb = Math.round(b + (255 - b) * t)
  return `FF${mr.toString(16).padStart(2, '0')}${mg.toString(16).padStart(2, '0')}${mb.toString(16).padStart(2, '0')}`.toUpperCase()
}

/** Low (cool green) → high (warm red) cost heat. */
function costHeatArgb(value: number, min: number, max: number): string {
  if (!Number.isFinite(value) || max <= min) return 'FFE8F5E9'
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  // green #22c55e → amber #f59e0b → red #ef4444
  const stops: [number, number, number][] = [
    [34, 197, 94],
    [245, 158, 11],
    [239, 68, 68],
  ]
  const seg = t < 0.5 ? 0 : 1
  const local = t < 0.5 ? t * 2 : (t - 0.5) * 2
  const a = stops[seg]
  const b = stops[seg + 1]
  const r = Math.round(a[0] + (b[0] - a[0]) * local)
  const g = Math.round(a[1] + (b[1] - a[1]) * local)
  const bl = Math.round(a[2] + (b[2] - a[2]) * local)
  // Tint toward white so text stays readable
  return mixHex(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`, 0.55)
}

function solid(argbColor: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } }
}

function font(opts: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: 'Calibri', size: 11, color: { argb: INK }, ...opts }
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const edge: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFE2E8F0' } }
  return { top: edge, left: edge, bottom: edge, right: edge }
}

function costRange(values: (number | null | undefined)[]): { min: number; max: number } {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
  if (!nums.length) return { min: 0, max: 0 }
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

function applyHeaderNotes(row: ExcelJS.Row, hints: readonly string[]) {
  hints.forEach((hint, i) => {
    const cell = row.getCell(i + 1)
    cell.note = hint
  })
}

function styleHeaderRow(row: ExcelJS.Row, colCount: number) {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c)
    cell.fill = solid(HEADER_FILL)
    cell.font = font({ bold: true, color: { argb: WHITE }, size: 11 })
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
    cell.border = thinBorder()
  }
  row.height = 22
}

function paintTypeLegend(sheet: ExcelJS.Worksheet, startRow: number, types: ItemType[]): number {
  sheet.getCell(startRow, 1).value = 'Type colors'
  sheet.getCell(startRow, 1).font = font({ bold: true, size: 10, color: { argb: MUTED } })
  let col = 2
  for (const t of types) {
    const cell = sheet.getCell(startRow, col)
    cell.value = t
    cell.fill = solid(argb(TYPE_COLORS[t]))
    cell.font = font({ bold: true, size: 9, color: { argb: INK } })
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = thinBorder()
    sheet.getColumn(col).width = Math.max(sheet.getColumn(col).width ?? 10, 11)
    col += 1
  }
  return startRow
}

function paintDayLegend(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  meta: TripRecord['meta'],
  dates: string[],
): number {
  if (!dates.length) return startRow
  sheet.getCell(startRow, 1).value = 'Day colors'
  sheet.getCell(startRow, 1).font = font({ bold: true, size: 10, color: { argb: MUTED } })
  const show = dates.slice(0, 14)
  show.forEach((d, i) => {
    const cell = sheet.getCell(startRow, i + 2)
    cell.value = d.slice(5) // MM-DD
    cell.fill = solid(mixHex(dayColor(meta, d), 0.35))
    cell.font = font({ size: 9, bold: true })
    cell.alignment = { horizontal: 'center' }
    cell.border = thinBorder()
  })
  if (dates.length > 14) {
    sheet.getCell(startRow, show.length + 2).value = '…'
    sheet.getCell(startRow, show.length + 2).font = font({ size: 9, color: { argb: MUTED } })
  }
  return startRow
}

function setColWidths(sheet: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w
  })
}

function buildTripSheet(wb: ExcelJS.Workbook, trip: TripRecord) {
  const sheet = wb.addWorksheet('Trip', {
    properties: { defaultRowHeight: 18 },
    views: [{ showGridLines: false }],
  })
  sheet.getColumn(1).width = 18
  sheet.getColumn(2).width = 48
  sheet.getColumn(3).width = 36

  sheet.mergeCells('A1:B1')
  const title = sheet.getCell('A1')
  title.value = trip.meta.name || 'Trip'
  title.font = font({ bold: true, size: 20, color: { argb: WHITE } })
  title.fill = solid(BRAND)
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
  sheet.getRow(1).height = 36

  sheet.getCell('A2').value = 'Trip overview'
  sheet.getCell('A2').font = font({ size: 10, color: { argb: MUTED }, italic: true })

  const fields: [string, string | number][] = [
    ['name', trip.meta.name],
    ['start_date', trip.meta.startDate],
    ['end_date', trip.meta.endDate],
    ['home_currency', trip.meta.homeCurrency],
    ['timezone_note', trip.meta.timezoneNote],
    ['travelers', trip.meta.travelers],
    ['notes', trip.meta.notes],
  ]

  sheet.getCell('A4').value = 'key'
  sheet.getCell('B4').value = 'value'
  styleHeaderRow(sheet.getRow(4), 2)

  fields.forEach(([key, value], i) => {
    const r = 5 + i
    const keyCell = sheet.getCell(r, 1)
    const valCell = sheet.getCell(r, 2)
    keyCell.value = key
    valCell.value = value
    keyCell.font = font({ bold: true, size: 11 })
    keyCell.fill = solid(i % 2 === 0 ? SOFT : PAPER)
    valCell.fill = solid(i % 2 === 0 ? SOFT : PAPER)
    keyCell.border = thinBorder()
    valCell.border = thinBorder()
    valCell.alignment = { wrapText: true, vertical: 'top' }
    if (key === 'notes') sheet.getRow(r).height = 48
  })

  const tipStart = 5 + fields.length + 1
  sheet.mergeCells(`A${tipStart}:B${tipStart}`)
  sheet.getCell(tipStart, 1).value = 'How to use'
  sheet.getCell(tipStart, 1).font = font({ bold: true, size: 12, color: { argb: BRAND } })

  const tips = [
    'Edit Steps for day plans (sights, food, drives, flights). Use Hotels for stays.',
    'Cash is a read-only spend snapshot with charts — ignored on import.',
    'Hover column headers on Steps/Hotels for Required/Optional format tips.',
    'Preferred date: YYYY-MM-DD · Preferred time: HH:MM (24h). Other common formats still import.',
    'Date cells use day colors; Type uses category colors; Cost uses a low→high heat scale.',
  ]
  tips.forEach((t, i) => {
    const r = tipStart + 1 + i
    sheet.mergeCells(`A${r}:B${r}`)
    sheet.getCell(r, 1).value = t
    sheet.getCell(r, 1).font = font({ size: 10, color: { argb: MUTED } })
    sheet.getCell(r, 1).fill = solid(i % 2 === 0 ? 'FFFFF7F4' : PAPER)
  })
}

function buildStepsSheet(wb: ExcelJS.Workbook, trip: TripRecord, items: TripItem[]) {
  const sheet = wb.addWorksheet('Steps', {
    views: [{ state: 'frozen', ySplit: 4 }],
  })
  const steps = items.filter((it) => it.type !== 'hotel' && !isPlaceholderItem(it))
  const dates = [...new Set(steps.map((s) => s.date).filter(Boolean))].sort()
  const costs = costRange(steps.map((s) => s.cost))

  sheet.mergeCells('A1:T1')
  sheet.getCell('A1').value = `Steps — ${trip.meta.name}`
  sheet.getCell('A1').font = font({ bold: true, size: 16, color: { argb: WHITE } })
  sheet.getCell('A1').fill = solid('FF0D9488')
  sheet.getCell('A1').alignment = { vertical: 'middle', indent: 1 }
  sheet.getRow(1).height = 28

  paintTypeLegend(
    sheet,
    2,
    ITEM_TYPES.filter((t) => t !== 'hotel'),
  )
  paintDayLegend(sheet, 3, trip.meta, dates)

  const headerRow = 4
  const rows = steps.map((item) => [
    item.date,
    item.start || '',
    item.end || '',
    item.type,
    item.title,
    item.place || '',
    item.city || '',
    item.from || '',
    item.to || '',
    item.confirm || '',
    item.cost,
    item.currency || '',
    item.status,
    item.notes || '',
    item.url || '',
    tagsJoined(item),
    item.lat,
    item.lon,
    item.latTo,
    item.lonTo,
  ])

  // Ensure table has at least one data row for Excel table validity
  const tableRows = rows.length ? rows : [Array(STEPS_COLS.length).fill('')]

  sheet.addTable({
    name: 'StepsTable',
    ref: `A${headerRow}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: false },
    columns: STEPS_COLS.map((name) => ({ name, filterButton: true })),
    rows: tableRows,
  })

  styleHeaderRow(sheet.getRow(headerRow), STEPS_COLS.length)
  applyHeaderNotes(sheet.getRow(headerRow), STEPS_HINTS)

  const dateCol = 1
  const typeCol = 4
  const costCol = 11
  const statusCol = 13

  for (let i = 0; i < tableRows.length; i++) {
    const r = headerRow + 1 + i
    const item = steps[i]
    const row = sheet.getRow(r)
    for (let c = 1; c <= STEPS_COLS.length; c++) {
      row.getCell(c).border = thinBorder()
      row.getCell(c).font = font()
      row.getCell(c).alignment = { vertical: 'middle' }
    }
    if (!item) continue

    const dayFill = mixHex(dayColor(trip.meta, item.date), 0.72)
    row.getCell(dateCol).fill = solid(dayFill)
    row.getCell(dateCol).font = font({ bold: true })

    const typeFill = argb(TYPE_COLORS[item.type] ?? '#cbd5e1')
    row.getCell(typeCol).fill = solid(typeFill)
    row.getCell(typeCol).font = font({ bold: true })

    if (item.cost != null && Number.isFinite(item.cost) && item.cost > 0) {
      row.getCell(costCol).fill = solid(costHeatArgb(item.cost, costs.min, costs.max))
      row.getCell(costCol).font = font({ bold: true })
      row.getCell(costCol).numFmt = '#,##0.00'
    }

    const st = STATUS_FILL[item.status]
    if (st) row.getCell(statusCol).fill = solid(st)
  }

  setColWidths(sheet, [12, 7, 7, 12, 28, 18, 12, 10, 10, 12, 10, 9, 10, 28, 22, 14, 10, 10, 10, 10])

  // Cost heat key
  const keyRow = headerRow + tableRows.length + 2
  sheet.getCell(keyRow, 1).value = 'Cost heat'
  sheet.getCell(keyRow, 1).font = font({ bold: true, size: 10, color: { argb: MUTED } })
  ;['Low', 'Mid', 'High'].forEach((label, i) => {
    const cell = sheet.getCell(keyRow, 2 + i)
    cell.value = label
    cell.fill = solid(costHeatArgb(i, 0, 2))
    cell.font = font({ size: 9, bold: true })
    cell.alignment = { horizontal: 'center' }
    cell.border = thinBorder()
  })
}

function buildHotelsSheet(wb: ExcelJS.Workbook, trip: TripRecord, items: TripItem[]) {
  const sheet = wb.addWorksheet('Hotels', {
    views: [{ state: 'frozen', ySplit: 4 }],
  })
  const hotels = items.filter((it) => it.type === 'hotel' && !isPlaceholderItem(it))
  const dates = [...new Set(hotels.map((h) => h.date).filter(Boolean))].sort()
  const costs = costRange(hotels.map((h) => h.cost))

  sheet.mergeCells('A1:M1')
  sheet.getCell('A1').value = `Hotels — ${trip.meta.name}`
  sheet.getCell('A1').font = font({ bold: true, size: 16, color: { argb: WHITE } })
  sheet.getCell('A1').fill = solid('FFA78BFA')
  sheet.getCell('A1').alignment = { vertical: 'middle', indent: 1 }
  sheet.getRow(1).height = 28

  paintTypeLegend(sheet, 2, ['hotel'])
  paintDayLegend(sheet, 3, trip.meta, dates)

  const headerRow = 4
  const rows = hotels.map((item) => [
    item.date,
    item.endDate || item.date,
    item.title,
    item.place || '',
    item.city || '',
    item.confirm || '',
    item.cost,
    item.currency || '',
    item.status,
    item.notes || '',
    item.url || '',
    item.lat,
    item.lon,
  ])
  const tableRows = rows.length ? rows : [Array(HOTELS_COLS.length).fill('')]

  sheet.addTable({
    name: 'HotelsTable',
    ref: `A${headerRow}`,
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium4', showRowStripes: false },
    columns: HOTELS_COLS.map((name) => ({ name, filterButton: true })),
    rows: tableRows,
  })

  styleHeaderRow(sheet.getRow(headerRow), HOTELS_COLS.length)
  applyHeaderNotes(sheet.getRow(headerRow), HOTELS_HINTS)

  for (let i = 0; i < tableRows.length; i++) {
    const r = headerRow + 1 + i
    const item = hotels[i]
    const row = sheet.getRow(r)
    for (let c = 1; c <= HOTELS_COLS.length; c++) {
      row.getCell(c).border = thinBorder()
      row.getCell(c).font = font()
      row.getCell(c).alignment = { vertical: 'middle' }
    }
    if (!item) continue

    const checkInFill = mixHex(dayColor(trip.meta, item.date), 0.72)
    row.getCell(1).fill = solid(checkInFill)
    row.getCell(1).font = font({ bold: true })
    if (item.endDate) {
      row.getCell(2).fill = solid(mixHex(dayColor(trip.meta, item.endDate), 0.82))
    }

    row.getCell(3).fill = solid(mixHex(TYPE_COLORS.hotel, 0.55))
    row.getCell(3).font = font({ bold: true })

    if (item.cost != null && Number.isFinite(item.cost) && item.cost > 0) {
      row.getCell(7).fill = solid(costHeatArgb(item.cost, costs.min, costs.max))
      row.getCell(7).font = font({ bold: true })
      row.getCell(7).numFmt = '#,##0.00'
    }

    const st = STATUS_FILL[item.status]
    if (st) row.getCell(9).fill = solid(st)
  }

  setColWidths(sheet, [12, 12, 26, 18, 12, 12, 10, 9, 10, 28, 22, 10, 10])

  const keyRow = headerRow + tableRows.length + 2
  sheet.getCell(keyRow, 1).value = 'Cost heat'
  sheet.getCell(keyRow, 1).font = font({ bold: true, size: 10, color: { argb: MUTED } })
  ;['Low', 'Mid', 'High'].forEach((label, i) => {
    const cell = sheet.getCell(keyRow, 2 + i)
    cell.value = label
    cell.fill = solid(costHeatArgb(i, 0, 2))
    cell.font = font({ size: 9, bold: true })
    cell.alignment = { horizontal: 'center' }
    cell.border = thinBorder()
  })
}

function paintBarRow(
  sheet: ExcelJS.Worksheet,
  row: number,
  label: string,
  value: number,
  max: number,
  colorHex: string,
  totalForShare?: number,
) {
  const labelCol = 1
  const valueCol = 2
  const barStartCol = 4

  sheet.getCell(row, labelCol).value = label
  sheet.getCell(row, labelCol).font = font({ bold: true })
  sheet.getCell(row, labelCol).fill = solid(mixHex(colorHex, 0.55))
  sheet.getCell(row, labelCol).border = thinBorder()

  sheet.getCell(row, valueCol).value = Math.round(value * 100) / 100
  sheet.getCell(row, valueCol).numFmt = '#,##0.00'
  sheet.getCell(row, valueCol).font = font({ bold: true })
  sheet.getCell(row, valueCol).border = thinBorder()

  const shareBase = totalForShare != null && totalForShare > 0 ? totalForShare : max
  const share = shareBase > 0 ? value / shareBase : 0
  sheet.getCell(row, valueCol + 1).value = share
  sheet.getCell(row, valueCol + 1).numFmt = '0%'
  sheet.getCell(row, valueCol + 1).border = thinBorder()

  const barPct = max > 0 ? value / max : 0
  const filled = Math.max(value > 0 ? 1 : 0, Math.round(barPct * BAR_MAX))
  for (let i = 0; i < BAR_MAX; i++) {
    const cell = sheet.getCell(row, barStartCol + i)
    cell.border = thinBorder()
    if (i < filled) {
      cell.fill = solid(argb(colorHex))
      cell.value = ''
    } else {
      cell.fill = solid('FFF8FAFC')
    }
  }
}

function buildCashSheet(wb: ExcelJS.Workbook, trip: TripRecord, items: TripItem[]) {
  const sheet = wb.addWorksheet('Cash', {
    views: [{ showGridLines: false }],
  })
  setColWidths(sheet, [14, 12, 8, ...Array(BAR_MAX).fill(2.2), 4, 14, 12])

  const spendable = items.filter(
    (it) =>
      !isPlaceholderItem(it) &&
      it.status !== 'cancelled' &&
      it.cost != null &&
      Number.isFinite(it.cost),
  )

  const byType = new Map<string, number>()
  const byCur = new Map<string, number>()
  const byDay = new Map<string, number>()
  for (const item of spendable) {
    byType.set(item.type, (byType.get(item.type) ?? 0) + (item.cost as number))
    const cur = normalizeCurrency(item.currency || trip.meta.homeCurrency)
    byCur.set(cur, (byCur.get(cur) ?? 0) + (item.cost as number))
    byDay.set(item.date, (byDay.get(item.date) ?? 0) + (item.cost as number))
  }

  const typeEntries = [...byType.entries()].sort((a, b) => b[1] - a[1])
  const curEntries = [...byCur.entries()].sort((a, b) => b[1] - a[1])
  const days = tripDays(trip.meta, items)
  const dayEntries = days
    .map((d) => [d, byDay.get(d) ?? 0] as const)
    .filter(([, v]) => v > 0)

  const total = typeEntries.reduce((s, [, v]) => s + v, 0)
  const maxType = typeEntries[0]?.[1] ?? 0
  const maxCur = curEntries[0]?.[1] ?? 0
  const maxDay = Math.max(0, ...dayEntries.map(([, v]) => v))

  sheet.mergeCells(`A1:P1`)
  sheet.getCell('A1').value = `Cash — ${trip.meta.name}`
  sheet.getCell('A1').font = font({ bold: true, size: 16, color: { argb: WHITE } })
  sheet.getCell('A1').fill = solid(BRAND)
  sheet.getCell('A1').alignment = { vertical: 'middle', indent: 1 }
  sheet.getRow(1).height = 28

  sheet.mergeCells('A2:P2')
  sheet.getCell('A2').value =
    'Export-only snapshot (ignored on import). Amounts as entered — no FX conversion. Bars mirror the in-app spend charts.'
  sheet.getCell('A2').font = font({ size: 10, italic: true, color: { argb: MUTED } })

  sheet.getCell('A3').value = 'Total entered'
  sheet.getCell('A3').font = font({ bold: true, color: { argb: MUTED } })
  sheet.getCell('B3').value = Math.round(total * 100) / 100
  sheet.getCell('B3').numFmt = '#,##0.00'
  sheet.getCell('B3').font = font({ bold: true, size: 14, color: { argb: BRAND } })
  sheet.getCell('C3').value = trip.meta.homeCurrency
  sheet.getCell('C3').font = font({ size: 10, color: { argb: MUTED } })

  // —— By type chart ——
  let r = 5
  sheet.getCell(r, 1).value = 'By type'
  sheet.getCell(r, 1).font = font({ bold: true, size: 13, color: { argb: 'FF0D9488' } })
  r += 1
  ;['Type', 'Total', 'Share'].forEach((h, i) => {
    const cell = sheet.getCell(r, i + 1)
    cell.value = h
    cell.fill = solid(HEADER_FILL)
    cell.font = font({ bold: true, color: { argb: WHITE }, size: 10 })
    cell.border = thinBorder()
  })
  sheet.getCell(r, 4).value = 'Chart'
  sheet.getCell(r, 4).fill = solid(HEADER_FILL)
  sheet.getCell(r, 4).font = font({ bold: true, color: { argb: WHITE }, size: 10 })
  if (typeEntries.length) {
    sheet.mergeCells(r, 4, r, 3 + BAR_MAX)
  }
  r += 1

  if (!typeEntries.length) {
    sheet.getCell(r, 1).value = '(none)'
    sheet.getCell(r, 2).value = 0
    r += 1
  } else {
    for (const [type, value] of typeEntries) {
      paintBarRow(
        sheet,
        r,
        type,
        value,
        maxType,
        TYPE_COLORS[type as ItemType] ?? '#94a3b8',
        total,
      )
      r += 1
    }
  }

  // —— By currency ——
  r += 1
  sheet.getCell(r, 1).value = 'By currency'
  sheet.getCell(r, 1).font = font({ bold: true, size: 13, color: { argb: 'FF3B82F6' } })
  r += 1
  ;['Currency', 'Total', 'Share'].forEach((h, i) => {
    const cell = sheet.getCell(r, i + 1)
    cell.value = h
    cell.fill = solid(HEADER_FILL)
    cell.font = font({ bold: true, color: { argb: WHITE }, size: 10 })
  })
  sheet.getCell(r, 4).value = 'Chart'
  sheet.getCell(r, 4).fill = solid(HEADER_FILL)
  sheet.getCell(r, 4).font = font({ bold: true, color: { argb: WHITE }, size: 10 })
  if (curEntries.length) sheet.mergeCells(r, 4, r, 3 + BAR_MAX)
  r += 1

  const curColors = ['#3b82f6', '#0d9488', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6']
  if (!curEntries.length) {
    sheet.getCell(r, 1).value = '(none)'
    sheet.getCell(r, 2).value = 0
    r += 1
  } else {
    curEntries.forEach(([cur, value], i) => {
      paintBarRow(sheet, r, cur, value, maxCur, curColors[i % curColors.length], total)
      r += 1
    })
  }

  // —— By day ——
  r += 1
  sheet.getCell(r, 1).value = 'By day'
  sheet.getCell(r, 1).font = font({ bold: true, size: 13, color: { argb: BRAND } })
  r += 1
  ;['Date', 'Total', 'Share'].forEach((h, i) => {
    const cell = sheet.getCell(r, i + 1)
    cell.value = h
    cell.fill = solid(HEADER_FILL)
    cell.font = font({ bold: true, color: { argb: WHITE }, size: 10 })
  })
  sheet.getCell(r, 4).value = 'Chart'
  sheet.getCell(r, 4).fill = solid(HEADER_FILL)
  sheet.getCell(r, 4).font = font({ bold: true, color: { argb: WHITE }, size: 10 })
  if (dayEntries.length) sheet.mergeCells(r, 4, r, 3 + BAR_MAX)
  r += 1

  if (!dayEntries.length) {
    sheet.getCell(r, 1).value = '(none)'
    sheet.getCell(r, 2).value = 0
  } else {
    for (const [date, value] of dayEntries) {
      paintBarRow(sheet, r, date, value, maxDay, dayColor(trip.meta, date), total)
      r += 1
    }
  }
}

export function buildTripWorkbook(trip: TripRecord): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Trip Tracker'
  wb.created = new Date()
  wb.modified = new Date()
  const items = sortItems(trip.items)

  buildTripSheet(wb, trip)
  buildStepsSheet(wb, trip, items)
  buildHotelsSheet(wb, trip, items)
  buildCashSheet(wb, trip, items)

  return wb
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Binary for Drive upload / programmatic import (same bytes as a downloaded .xlsx). */
export async function workbookToArrayBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const written = await wb.xlsx.writeBuffer()
  if (written instanceof ArrayBuffer) return written
  if (ArrayBuffer.isView(written)) {
    const view = written as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  // Node Buffer
  const nodeBuf = written as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  return nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength)
}

export function tripToBlankTemplate(): ExcelJS.Workbook {
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
      notes: 'Fill Steps + Hotels. Cash is filled automatically on export.',
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
        start: '',
        end: '',
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
      {
        id: 'S01',
        type: 'sight',
        title: 'Example sight',
        place: '',
        city: 'Paris',
        date: '2026-10-02',
        endDate: '',
        start: '11:00',
        end: '',
        from: '',
        to: '',
        confirm: '',
        cost: null,
        currency: 'EUR',
        status: 'planned',
        notes: '',
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
