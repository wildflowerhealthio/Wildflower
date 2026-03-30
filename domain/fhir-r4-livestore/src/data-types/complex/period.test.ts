import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Period } from './period.ts'
import type { PeriodEncoded } from './period.ts'

const periodArb = Arbitrary.make(Period)

describe('Period model', () => {
  test('Period.ResourceType is "Period"', () => {
    expect(Period.ResourceType).toBe('Period')
  })

  test('types', () => {
    expectTypeOf(Period.Encoded).toExtend<PeriodEncoded>()
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(periodArb, (period) => {
        const encoded = Schema.encodeSync(Period)(period)
        const decoded = Schema.decodeSync(Period)(encoded)
        expect(decoded).toSchemaEqual(period)
      })
    )
  })

  test('should handle google style input', () => {
    const decode = Schema.decodeSync(Period)

    const decoded = decode({
      end: '2026-01-07T00:00:00.000Z',
      start: '2026-01-04T00:00:00.000Z',
      id: '123',
    })

    expect(decoded.start).toEqual(DateTime.unsafeMake('2026-01-04T00:00:00.000Z'))
    expect(decoded.end).toEqual(DateTime.unsafeMake('2026-01-07T00:00:00.000Z'))
  })
})
