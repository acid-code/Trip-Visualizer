import { describe, expect, it } from 'vitest'
import {
  FEATURE_TIPS,
  featureTipsForContexts,
  parseSeenTipIds,
  serializeSeenTipIds,
  unseenFeatureTips,
  unseenFeatureTipsForContexts,
} from './featureGuide'

describe('featureGuide', () => {
  it('keeps unique tip ids', () => {
    const ids = FEATURE_TIPS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('filters unseen tips by context', () => {
    const seen = new Set(['google-drive-sync'])
    const settings = unseenFeatureTipsForContexts(seen, ['settings'])
    expect(settings.every((t) => t.context === 'settings')).toBe(true)
    expect(settings.some((t) => t.id === 'google-drive-sync')).toBe(false)
    expect(settings.some((t) => t.id === 'partner-sharing')).toBe(true)
    expect(settings.some((t) => t.id === 'my-maps-export')).toBe(true)
  })

  it('returns all tips for a context when browsing', () => {
    const plan = featureTipsForContexts(['plan'])
    expect(plan.length).toBeGreaterThanOrEqual(3)
    expect(plan.every((t) => t.context === 'plan')).toBe(true)
  })

  it('round-trips seen ids', () => {
    const raw = serializeSeenTipIds(['partner-sharing', 'my-maps-export', 'partner-sharing'])
    const seen = parseSeenTipIds(raw)
    expect(seen.has('partner-sharing')).toBe(true)
    expect(seen.has('my-maps-export')).toBe(true)
    expect(unseenFeatureTips(seen).some((t) => t.id === 'partner-sharing')).toBe(false)
  })
})
