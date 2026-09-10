/** Currency helpers + Frankfurter (ECB) FX rates for trip spend totals. */

const ALIASES: Record<string, string> = {
  NIS: 'ILS',
  SHEKEL: 'ILS',
  SHEKELS: 'ILS',
  '₪': 'ILS',
  EURO: 'EUR',
  EUROS: 'EUR',
  '€': 'EUR',
  DOLLAR: 'USD',
  DOLLARS: 'USD',
  USDOLLAR: 'USD',
  '$': 'USD',
  US$: 'USD',
  POUND: 'GBP',
  '£': 'GBP',
  YEN: 'JPY',
  '¥': 'JPY',
}

/** Common trip currencies for UI selects */
export const COMMON_CURRENCIES = [
  'ILS',
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'THB',
  'TRY',
  'AED',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'SEK',
  'NOK',
  'DKK',
] as const

export type FxRates = {
  /** ISO date of the rate table */
  date: string
  /** Multiply amount in `code` by rates[code] to get EUR, then… stored as EUR→code */
  eurTo: Record<string, number>
}

const FALLBACK_EUR_TO: Record<string, number> = {
  EUR: 1,
  USD: 1.08,
  ILS: 4.0,
  GBP: 0.86,
  CHF: 0.96,
  JPY: 163,
  CAD: 1.47,
  AUD: 1.66,
  THB: 39,
  TRY: 35,
  AED: 3.97,
  PLN: 4.3,
  CZK: 25,
  HUF: 395,
  RON: 5,
  SEK: 11.2,
  NOK: 11.5,
  DKK: 7.46,
}

let cache: { at: number; rates: FxRates } | null = null
const CACHE_MS = 12 * 60 * 60 * 1000

export function normalizeCurrency(code: string | undefined | null, fallback = 'EUR'): string {
  const raw = String(code ?? '')
    .trim()
    .toUpperCase()
  if (!raw) return fallback.toUpperCase()
  if (ALIASES[raw]) return ALIASES[raw]
  // strip symbols glued to codes: "USD$" etc.
  const cleaned = raw.replace(/[^A-Z]/g, '')
  if (ALIASES[cleaned]) return ALIASES[cleaned]
  if (/^[A-Z]{3}$/.test(cleaned)) return cleaned
  return fallback.toUpperCase()
}

export async function fetchFxRates(): Promise<FxRates> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rates

  try {
    const res = await fetch('https://api.frankfurter.app/latest')
    if (!res.ok) throw new Error(String(res.status))
    const json = (await res.json()) as {
      date?: string
      base?: string
      rates?: Record<string, number>
    }
    const eurTo: Record<string, number> = { EUR: 1, ...(json.rates ?? {}) }
    const rates: FxRates = { date: json.date || new Date().toISOString().slice(0, 10), eurTo }
    cache = { at: Date.now(), rates }
    return rates
  } catch {
    const rates: FxRates = {
      date: 'fallback',
      eurTo: { ...FALLBACK_EUR_TO },
    }
    cache = { at: Date.now(), rates }
    return rates
  }
}

/** Convert amount from one currency to another using EUR-based table. */
export function convertAmount(
  amount: number,
  fromRaw: string,
  toRaw: string,
  rates: FxRates,
): number | null {
  if (!Number.isFinite(amount)) return null
  const from = normalizeCurrency(fromRaw)
  const to = normalizeCurrency(toRaw)
  if (from === to) return amount

  const fromRate = rates.eurTo[from]
  const toRate = rates.eurTo[to]
  if (fromRate == null || toRate == null || fromRate === 0) return null

  // amount_from → EUR → to
  const inEur = amount / fromRate
  const out = inEur * toRate
  return Number.isFinite(out) ? out : null
}
