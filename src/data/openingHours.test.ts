import { describe, expect, it } from 'vitest'
import {
  weeklyHoursFromPeriods,
  weeklyHoursLines,
  type OpeningPeriod,
} from './openingHours'

describe('weeklyHoursLines', () => {
  it('splits Google weekday text into Mon-style lines', () => {
    const lines = weeklyHoursLines({
      openingHours:
        'Monday: 9:00 AM – 6:00 PM; Tuesday: Closed; Wednesday: 9:00 AM – 6:00 PM; Thursday: 9:00 AM – 9:00 PM; Friday: 9:00 AM – 6:00 PM; Saturday: 9:00 AM – 6:00 PM; Sunday: 9:00 AM – 6:00 PM',
    })
    expect(lines[0]).toBe('Mon: 9:00 AM – 6:00 PM')
    expect(lines[1]).toBe('Tue: Closed')
    expect(lines).toHaveLength(7)
  })

  it('builds a week from periods when text is missing', () => {
    const periods: OpeningPeriod[] = [
      { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
      { open: { day: 3, hour: 10, minute: 0 }, close: { day: 3, hour: 17, minute: 30 } },
    ]
    const lines = weeklyHoursFromPeriods(periods)
    expect(lines[0]).toBe('Mon: 09:00–18:00')
    expect(lines[1]).toBe('Tue: Closed')
    expect(lines[2]).toBe('Wed: 10:00–17:30')
    expect(lines[6]).toBe('Sun: Closed')
  })
})
