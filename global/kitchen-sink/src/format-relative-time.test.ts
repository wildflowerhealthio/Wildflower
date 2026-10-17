import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { formatRelativeTime } from './format-relative-time.ts'
import { numRunsFor } from './test/index.ts'

// A fixed "now" so all relative-time assertions are deterministic.
const NOW_MS = 1_700_000_000_000
const NOW: DateTime.DateTime = DateTime.unsafeMake(NOW_MS)
const dt = (offsetMs: number): DateTime.DateTime => DateTime.unsafeMake(NOW_MS - offsetMs)
const DAY_MS = 24 * 60 * 60_000

/** The buckets in the order a growing gap passes through them. */
const BUCKETS = ['now', 'min', 'hr', 'day', 'week', 'month'] as const

/**
 * Where a formatted gap sits: its bucket's place in {@link BUCKETS}, then its
 * count. Read off the text, so the property below checks what users see.
 */
const rankOf = (formatted: string): readonly [number, number] => {
  if (formatted === 'now') return [0, 0]
  const [count = '', unit = ''] = formatted.split(' ')
  const bucket = BUCKETS.findIndex((name) => unit.startsWith(name))
  if (bucket === -1) throw new Error(`unrecognised relative time "${formatted}"`)
  return [bucket, Number(count)]
}

describe('formatRelativeTime', () => {
  // Bucket boundaries — verifies the cutoffs callers depend on, so a
  // value that should read "now" doesn't unexpectedly flip to "1 min
  // ago" across a refactor.
  test.each([
    [0, 'now'],
    [59_000, 'now'],
    [60_000, '1 min ago'],
    [119_000, '1 min ago'],
    [60 * 60_000, '1 hr ago'],
    [2 * 60 * 60_000, '2 hr ago'],
    [24 * 60 * 60_000, '1 day ago'],
    [3 * DAY_MS, '3 days ago'],
    [13 * DAY_MS, '13 days ago'],
    [14 * DAY_MS, '2 weeks ago'],
    [62 * DAY_MS, '8 weeks ago'],
    [63 * DAY_MS, '2 months ago'],
    [365 * DAY_MS, '11 months ago'],
  ] as const)('formats %i ms ago as "%s"', (offsetMs, expected) => {
    expect(formatRelativeTime(dt(offsetMs), NOW)).toBe(expected)
  })

  // A longer gap never reads as a shorter one: the bucket never steps back,
  // and within a bucket the count never shrinks.
  test('never goes backwards as the gap grows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 * 365 * DAY_MS }),
        fc.integer({ min: 0, max: 3 * 365 * DAY_MS }),
        (a, b) => {
          const [shorter, longer] = a <= b ? [a, b] : [b, a]
          const [shorterBucket, shorterCount] = rankOf(formatRelativeTime(dt(shorter), NOW))
          const [longerBucket, longerCount] = rankOf(formatRelativeTime(dt(longer), NOW))
          expect(
            longerBucket > shorterBucket ||
              (longerBucket === shorterBucket && longerCount >= shorterCount)
          ).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  // Future timestamps (clock skew) should clamp to "now" rather than
  // render a negative "−5 min ago".
  test('clamps future timestamps to "now"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 365 * 24 * 60 * 60_000 }), (futureOffsetMs) => {
        expect(formatRelativeTime(DateTime.unsafeMake(NOW_MS + futureOffsetMs), NOW)).toBe('now')
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
