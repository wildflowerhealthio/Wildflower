import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { describeDayFromNow } from './relative-day.ts'

const dayMillis = 86_400_000
const now = Date.parse('2026-06-01T00:00:00Z')
// An ISO instant exactly `days` whole days from `now`.
const isoDaysFromNow = (days: number): string => new Date(now + days * dayMillis).toISOString()

describe('describeDayFromNow', () => {
  test('is "today" at a zero-day offset', () => {
    expect(describeDayFromNow(isoDaysFromNow(0), now)).toBe('today')
  })

  test('future and past of the same magnitude are symmetric', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        const future = describeDayFromNow(isoDaysFromNow(days), now)
        const past = describeDayFromNow(isoDaysFromNow(-days), now)
        expect(future.startsWith('in ')).toBe(true)
        expect(past.endsWith(' ago')).toBe(true)
        expect(future.slice('in '.length)).toBe(past.slice(0, past.length - ' ago'.length))
      })
    )
  })

  test('coarsens: days up to ~10, then weeks up to ~8 weeks, then months', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        const phrase = describeDayFromNow(isoDaysFromNow(days), now).slice('in '.length)
        const unit = phrase.split(' ')[1]
        if (days <= 10) expect(unit).toMatch(/^days?$/)
        else if (days <= 56) expect(unit).toMatch(/^weeks?$/)
        else expect(unit).toMatch(/^months?$/)
      })
    )
  })

  test('uses the singular unit for a count of one and the plural otherwise', () => {
    expect(describeDayFromNow(isoDaysFromNow(1), now)).toBe('in 1 day')
    expect(describeDayFromNow(isoDaysFromNow(2), now)).toBe('in 2 days')
    // 7..13 days coarsen to 1 week (singular), 14+ to plural weeks.
    expect(describeDayFromNow(isoDaysFromNow(13), now)).toBe('in 1 week')
    expect(describeDayFromNow(isoDaysFromNow(14), now)).toBe('in 2 weeks')
  })

  test('reproduces the fixed reference points', () => {
    expect(describeDayFromNow('2026-06-04T00:00:00Z', now)).toBe('in 3 days')
    expect(describeDayFromNow('2026-06-15T00:00:00Z', now)).toBe('in 2 weeks')
    expect(describeDayFromNow('2026-07-31T00:00:00Z', now)).toBe('in 2 months')
    expect(describeDayFromNow('2026-05-29T00:00:00Z', now)).toBe('3 days ago')
    expect(describeDayFromNow('2026-05-18T00:00:00Z', now)).toBe('2 weeks ago')
  })
})
