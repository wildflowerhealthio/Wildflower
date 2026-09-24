import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf } from './dispense-request.ts'
import { base, decode } from './test-helpers.ts'

describe('repeatsAllowedOf / repeatsAvailableOf', () => {
  it('should read the total and the Wildflower remaining-repeats extension', () => {
    fc.assert(
      fc.property(fc.option(fc.nat(99)), fc.option(fc.nat(99)), (allowed, available) => {
        const request = decode({
          ...base,
          dispenseRequest: {
            ...(allowed === null ? {} : { numberOfRepeatsAllowed: allowed }),
            extension:
              available === null
                ? []
                : [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: available }],
          },
        })
        expect(repeatsAllowedOf(request)).toBe(allowed)
        expect(repeatsAvailableOf(request)).toBe(available)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should ignore a remaining-repeats count under any other extension URL', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.nat(99), (url, count) => {
        fc.pre(url !== WildflowerExtension.RepeatsAvailable)
        const request = decode({
          ...base,
          dispenseRequest: { extension: [{ url, valueInteger: count }] },
        })
        expect(repeatsAvailableOf(request)).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('nextFillDateOf', () => {
  test('does not treat validityPeriod.end as a next fill date', () => {
    // `validityPeriod.end` is the *authorization* expiry in R4 — the last date
    // the script may be dispensed against, not when the current supply runs
    // out — so it must not surface as "next fill" on its own.
    const request = decode({
      ...base,
      authoredOn: '2026-06-01T00:00:00Z',
      dispenseRequest: {
        numberOfRepeatsAllowed: 2,
        validityPeriod: { start: '2026-06-01T00:00:00Z', end: '2026-09-01T00:00:00Z' },
      },
    })
    expect(nextFillDateOf(request)).toBeNull()
  })

  test('estimates next fill as authoredOn + expectedSupplyDuration', () => {
    const at = (supply: Record<string, unknown>, authoredOn?: string): string | null =>
      nextFillDateOf(
        decode({
          ...base,
          ...(authoredOn === undefined ? {} : { authoredOn }),
          dispenseRequest: {
            expectedSupplyDuration: supply,
            validityPeriod: { end: '2026-12-31T00:00:00Z' },
          },
        })
      )

    expect(at({ value: 30, unit: 'days', code: 'd' }, '2026-06-01T00:00:00Z')).toBe(
      '2026-07-01T00:00:00.000Z'
    )
    // A UCUM week code advances by whole weeks.
    expect(at({ value: 2, code: 'wk' }, '2026-06-01T00:00:00Z')).toBe('2026-06-15T00:00:00.000Z')
    // An unrecognized supply unit falls back to days.
    expect(at({ value: 30, unit: 'doses', code: '{dose}' }, '2026-06-01T00:00:00Z')).toBe(
      '2026-07-01T00:00:00.000Z'
    )
    // No authored date → no estimate.
    expect(at({ value: 30, code: 'd' })).toBeNull()
  })
})
