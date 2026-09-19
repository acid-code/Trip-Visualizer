import { describe, expect, it } from 'vitest'
import { groupDayPlan, isSpecialDayTheme } from './groupDayPlan'
import type { FullTripDraft } from './types'

function draftWithDays(
  days: FullTripDraft['dayPlan'],
): FullTripDraft {
  return {
    summary: '',
    spine: {
      id: 's1',
      label: 'Test',
      summary: '',
      openQuestions: [],
      areas: [],
    },
    dayPlan: days,
    planPlaceNames: [],
    items: [],
    openQuestions: [],
  }
}

describe('groupDayPlan', () => {
  it('keeps per-day themes inside one stay-zone', () => {
    const groups = groupDayPlan(
      draftWithDays([
        {
          date: '2026-10-03',
          areaLabel: 'Aix-en-Provence',
          theme: 'Birthday spa & gourmet dinner',
          why: 'Celebrate on the exact date',
          special: true,
          highlights: [{ name: 'Baumanière Spa', why: 'Birthday treat' }],
        },
        {
          date: '2026-10-04',
          areaLabel: 'Aix-en-Provence',
          theme: 'Cours Mirabeau stroll',
          highlights: [{ name: 'Cours Mirabeau', why: 'Classic boulevard' }],
        },
        {
          date: '2026-10-05',
          areaLabel: 'Aix-en-Provence',
          theme: 'Morning espresso & departure',
          highlights: [],
        },
      ]),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.start).toBe('2026-10-03')
    expect(groups[0]!.end).toBe('2026-10-05')
    expect(groups[0]!.days).toHaveLength(3)
    expect(groups[0]!.days[0]!.special).toBe(true)
    expect(groups[0]!.days[0]!.theme).toMatch(/Birthday/i)
    expect(groups[0]!.days[2]!.theme).toMatch(/Departure/i)
  })

  it('detects special days from theme text', () => {
    expect(isSpecialDayTheme('Birthday spa', '')).toBe(true)
    expect(isSpecialDayTheme('Market morning', '')).toBe(false)
  })
})
