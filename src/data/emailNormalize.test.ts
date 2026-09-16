import { describe, expect, it } from 'vitest'
import {
  emailDocKey,
  isValidInviteEmail,
  normalizeEmail,
} from './emailNormalize'

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alex@Gmail.COM ')).toBe('alex@gmail.com')
  })

  it('strips internal spaces', () => {
    expect(normalizeEmail('a lex@ex.com')).toBe('alex@ex.com')
  })
})

describe('emailDocKey', () => {
  it('is stable for the same email', () => {
    expect(emailDocKey('a@b.co')).toBe(emailDocKey('A@B.CO'))
  })

  it('returns empty for invalid', () => {
    expect(emailDocKey('nope')).toBe('nope')
  })

  it('uses normalized email as key', () => {
    expect(emailDocKey('  A@B.Co ')).toBe('a@b.co')
  })
})

describe('isValidInviteEmail', () => {
  it('accepts normal emails', () => {
    expect(isValidInviteEmail('partner@gmail.com')).toBe(true)
  })

  it('rejects junk', () => {
    expect(isValidInviteEmail('')).toBe(false)
    expect(isValidInviteEmail('not-an-email')).toBe(false)
    expect(isValidInviteEmail('@x.com')).toBe(false)
  })
})
