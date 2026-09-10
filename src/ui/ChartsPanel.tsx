import { useEffect, useState, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import type { TripItem, TripMeta } from '../domain/types'
import { distanceStats, nightsPerCity, spendSummary, typeMix } from '../data/analytics'
import { COMMON_CURRENCIES, fetchFxRates, type FxRates } from '../data/fx'

type Props = {
  meta: TripMeta
  items: TripItem[]
  onHomeCurrencyChange?: (code: string) => void
}

export function ChartsPanel({ meta, items, onHomeCurrencyChange }: Props) {
  const [rates, setRates] = useState<FxRates | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchFxRates().then((r) => {
      if (!cancelled) setRates(r)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const nights = nightsPerCity(items)
  const mix = typeMix(items)
  const dist = distanceStats(items)
  const spend = rates ? spendSummary(items, meta.homeCurrency, rates) : null

  return (
    <div className="h-full min-h-0 space-y-3 overflow-y-auto overscroll-contain pb-8 text-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-stone-200 bg-white px-3 py-2 shadow-sm">
        <div className="text-xs text-stone-500">
          Totals convert into your home currency (ECB rates
          {spend?.ratesDate && spend.ratesDate !== 'fallback' ? ` · ${spend.ratesDate}` : ''}).
        </div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-stone-600">
          Show as
          <select
            className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1 text-sm text-stone-900"
            value={meta.homeCurrency || 'EUR'}
            onChange={(e) => onHomeCurrencyChange?.(e.target.value)}
          >
            {currencyOptions(meta.homeCurrency).map((c) => (
              <option key={c} value={c}>
                {c === 'ILS' ? 'ILS (NIS)' : c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Steps" value={String(items.length)} />
        <Stat
          label={`Spend (${spend?.homeCurrency ?? meta.homeCurrency})`}
          value={spend ? formatMoney(spend.totalHome) : '…'}
        />
        <Stat label="Air / road km" value={`${dist.airKm}/${dist.roadKm}`} />
      </div>

      {spend && spend.byOriginalCurrency.length > 0 ? (
        <div className="rounded-2xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600 shadow-sm">
          <div className="mb-1 font-semibold uppercase tracking-wide text-stone-400">
            Entered currencies
          </div>
          <div className="flex flex-wrap gap-2">
            {spend.byOriginalCurrency.map((row) => (
              <span
                key={row.currency}
                className="rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-700"
              >
                {formatMoney(row.total)} {row.currency}
              </span>
            ))}
          </div>
          {spend.skipped > 0 ? (
            <p className="mt-1.5 text-amber-700">
              {spend.skipped} cost{spend.skipped === 1 ? '' : 's'} skipped (unknown currency).
            </p>
          ) : null}
        </div>
      ) : null}

      <ChartCard title={`Spend by type (${spend?.homeCurrency ?? meta.homeCurrency})`}>
        <ReactECharts
          style={{ height: 200 }}
          option={{
            backgroundColor: 'transparent',
            tooltip: {
              trigger: 'item',
              formatter: (p: { name?: string; value?: number; percent?: number }) =>
                `${p.name}: ${formatMoney(Number(p.value ?? 0))} (${p.percent}%)`,
            },
            series: [
              {
                type: 'pie',
                radius: ['42%', '70%'],
                data: (spend?.slices ?? []).map((s) => ({
                  name: s.type,
                  value: Math.round(s.value * 100) / 100,
                  itemStyle: { color: s.color },
                })),
                label: { color: '#44403c' },
              },
            ],
          }}
        />
      </ChartCard>

      <ChartCard title="Nights per city">
        <ReactECharts
          style={{ height: 180 }}
          option={{
            backgroundColor: 'transparent',
            textStyle: { color: '#57534e' },
            grid: { left: 40, right: 12, top: 20, bottom: 36 },
            xAxis: {
              type: 'category',
              data: nights.map((n) => n.city),
              axisLabel: { color: '#78716c', rotate: 20 },
            },
            yAxis: {
              type: 'value',
              minInterval: 1,
              axisLabel: { color: '#78716c' },
              splitLine: { lineStyle: { color: '#e7e5e4' } },
            },
            series: [
              {
                type: 'bar',
                data: nights.map((n) => n.nights),
                itemStyle: { color: '#ff6b4a', borderRadius: [6, 6, 0, 0] },
              },
            ],
          }}
        />
      </ChartCard>

      <ChartCard title="Step mix">
        <ReactECharts
          style={{ height: 180 }}
          option={{
            backgroundColor: 'transparent',
            grid: { left: 40, right: 12, top: 20, bottom: 36 },
            xAxis: {
              type: 'category',
              data: mix.map((m) => m.type),
              axisLabel: { color: '#78716c', rotate: 25 },
            },
            yAxis: {
              type: 'value',
              minInterval: 1,
              axisLabel: { color: '#78716c' },
              splitLine: { lineStyle: { color: '#e7e5e4' } },
            },
            series: [
              {
                type: 'bar',
                data: mix.map((m) => ({ value: m.count, itemStyle: { color: m.color } })),
              },
            ],
          }}
        />
      </ChartCard>
    </div>
  )
}

function currencyOptions(current: string) {
  const set = new Set<string>([...COMMON_CURRENCIES, normalizeOr(current)])
  return [...set]
}

function normalizeOr(code: string) {
  const c = (code || 'EUR').toUpperCase()
  return c === 'NIS' ? 'ILS' : c
}

function formatMoney(n: number) {
  if (!Number.isFinite(n)) return '0'
  return n >= 100 ? n.toFixed(0) : n.toFixed(2)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white px-2 py-3 shadow-sm">
      <div className="text-lg font-semibold text-[var(--coral-deep)]">{value}</div>
      <div className="text-[11px] text-stone-500">{label}</div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-2 shadow-sm">
      <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-stone-400">
        {title}
      </div>
      {children}
    </div>
  )
}
