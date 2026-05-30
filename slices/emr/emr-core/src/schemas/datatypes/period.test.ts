import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Period from './period.ts'

const periodArb = Arbitrary.make(Period.Schema)

describe('Period model', () => {
  test('Period.ResourceType is "Period"', () => {
    expect(Period.ResourceType).toBe('Period')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(periodArb, (period) => {
        const encoded = Schema.encodeSync(Period.Schema)(period)
        const decoded = Schema.decodeSync(Period.Schema)(encoded)
        expect(decoded).toSchemaEqual(Period.Schema, period)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should handle google style input', () => {
    const decode = Schema.decodeSync(Period.Schema)

    const decoded = decode({
      end: '2026-01-07T00:00:00.000Z',
      start: '2026-01-04T00:00:00.000Z',
      id: '123',
      extension: [],
    })

    expect(decoded.start).toEqual(DateTime.unsafeMake('2026-01-04T00:00:00.000Z'))
    expect(decoded.end).toEqual(DateTime.unsafeMake('2026-01-07T00:00:00.000Z'))
  })
})
