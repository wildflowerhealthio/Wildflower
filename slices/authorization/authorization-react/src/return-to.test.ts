import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { sanitizeReturnTo } from './return-to.ts'

describe('sanitizeReturnTo', () => {
  // Open-redirect guard: every same-origin absolute path is preserved
  // verbatim, and anything a browser would resolve to a different origin
  // (or that lacks a usable value) collapses to the default landing path.
  for (const [raw, expected] of [
    [null, '/home'],
    ['', '/home'],
    ['/dashboard', '/dashboard'],
    ['/patients/123?tab=meds#vitals', '/patients/123?tab=meds#vitals'],
    ['//evil.com', '/home'],
    ['/\\evil.com', '/home'],
    ['https://evil.com/phish', '/home'],
    ['javascript:alert(1)', '/home'],
    ['relative/path', '/home'],
  ] as const) {
    test(`maps ${JSON.stringify(raw)} to ${expected}`, () => {
      expect(sanitizeReturnTo(raw)).toBe(expected)
    })
  }

  test('output is always a same-origin absolute path (no open redirect)', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (raw) => {
        const result = sanitizeReturnTo(raw)
        // A leading single `/` (and never `//` or `/\`) is exactly what a
        // browser resolves against the current origin — so the result can
        // never escape to an attacker-controlled host.
        expect(result.startsWith('/')).toBe(true)
        expect(result.startsWith('//')).toBe(false)
        expect(result.startsWith('/\\')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
