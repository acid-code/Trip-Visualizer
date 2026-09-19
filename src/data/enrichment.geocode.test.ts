import { describe, expect, it } from 'vitest'
import {
  geocodeQueryVariants,
  normalizeGeocodeQuery,
} from './enrichment'

describe('normalizeGeocodeQuery', () => {
  it('strips stay-zone / base suffixes', () => {
    expect(normalizeGeocodeQuery('Avignon base')).toBe('Avignon')
    expect(normalizeGeocodeQuery('Nice stay-zone')).toBe('Nice')
  })

  it('expands airport codes', () => {
    expect(normalizeGeocodeQuery('NCE')).toMatch(/Nice/i)
    expect(normalizeGeocodeQuery('CDG airport')).toMatch(/Gaulle/i)
  })
})

describe('geocodeQueryVariants', () => {
  it('adds country hints for bare cities', () => {
    const v = geocodeQueryVariants('Avignon')
    expect(v[0]).toBe('Avignon')
    expect(v).toContain('Avignon, France')
  })

  it('dedupes and caps variants', () => {
    const v = geocodeQueryVariants('Nice, France')
    expect(v[0]).toBe('Nice, France')
    expect(v).toContain('Nice')
    expect(v.length).toBeLessThanOrEqual(6)
  })
})
