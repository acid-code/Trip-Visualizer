import { describe, expect, it } from 'vitest'
import { forFirestore, shareErrorMessage } from './shareErrors'

describe('forFirestore', () => {
  it('strips undefined fields', () => {
    expect(forFirestore({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null })
  })

  it('keeps nested plain data', () => {
    expect(forFirestore({ nested: { x: 'y' }, list: [1, 2] })).toEqual({
      nested: { x: 'y' },
      list: [1, 2],
    })
  })
})

describe('shareErrorMessage', () => {
  it('maps permission-denied', () => {
    expect(shareErrorMessage({ code: 'permission-denied' }, 'fallback')).toMatch(
      /Permission denied/,
    )
  })

  it('maps unavailable / network', () => {
    expect(shareErrorMessage({ code: 'unavailable' }, 'fallback')).toMatch(/Network/)
    expect(shareErrorMessage(new Error('offline mode'), 'fallback')).toMatch(/Network/)
  })

  it('maps invalid-argument / nested arrays', () => {
    expect(shareErrorMessage({ code: 'invalid-argument' }, 'fallback')).toMatch(
      /Could not upload/,
    )
    expect(shareErrorMessage(new Error('Nested arrays are not supported'), 'x')).toMatch(
      /Could not upload/,
    )
  })

  it('passes through config and PARTNER_UPDATED messages', () => {
    expect(
      shareErrorMessage(new Error('Sharing is not configured — set VITE_FIREBASE_*'), 'x'),
    ).toMatch(/VITE_FIREBASE/)
    expect(shareErrorMessage(new Error('PARTNER_UPDATED'), 'x')).toMatch(/Someone else updated/)
    expect(shareErrorMessage(new Error('SHARE_GONE'), 'x')).toMatch(/no longer available/)
  })

  it('passes short safe messages and falls back otherwise', () => {
    expect(shareErrorMessage(new Error('Only the trip owner can invite'), 'x')).toBe(
      'Only the trip owner can invite',
    )
    expect(shareErrorMessage(new Error('firebase internal stack boom'), 'fallback')).toBe(
      'fallback',
    )
    expect(shareErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
