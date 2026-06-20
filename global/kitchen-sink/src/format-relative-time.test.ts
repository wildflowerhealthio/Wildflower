import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { formatRelativeTime } from './format-relative-time.ts'
import { numRunsFor } from './test/index.ts'

// A fixed "now" so all relative-time assertions are deterministic.
const NOW_MS = 1_700_000_000_000
const NOW: DateTime.DateTime = DateTime.unsafeMake(NOW_MS)
const dt = (offsetMs: number): DateTime.DateTime => DateTime.unsafeMake(NOW_MS - offsetMs)

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
    [3 * 24 * 60 * 60_000, '3 days ago'],
  ] as const)('formats %i ms ago as "%s"', (offsetMs, expected) => {
    expect(formatRelativeTime(dt(offsetMs), NOW)).toBe(expected)
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
