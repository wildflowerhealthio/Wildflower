import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Period from './period.ts'

const decode = Schema.decodeUnknownSync(Period.Schema)
const at = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

describe('FhirR4Period', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Period.Schema), (period) => {
        const fhir = Schema.encodeSync(Period.Schema)(period)
        const decoded = Schema.decodeSync(Period.Schema)(fhir)
        expect(decoded).toSchemaEqual(Period.Schema, period)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each([
    ['2026-03-31', '2026-03-31T23:59:59.999Z'],
    ['2026-03', '2026-03-31T23:59:59.999Z'],
    ['2026-02', '2026-02-28T23:59:59.999Z'],
    ['2024-02', '2024-02-29T23:59:59.999Z'],
    ['2026', '2026-12-31T23:59:59.999Z'],
  ])('decodes a partial-date end %s to the last instant it covers, %s', (end, lastInstant) => {
    expect(decode({ end }).end).toEqual(at(lastInstant))
  })

  test('decodes a full dateTime end to that instant', () => {
    expect(decode({ end: '2026-03-31T09:00:00-04:00' }).end).toEqual(at('2026-03-31T13:00:00Z'))
  })

  test('decodes a partial-date start to the first instant it covers', () => {
    expect(decode({ start: '2026-03-31' }).start).toEqual(at('2026-03-31T00:00:00Z'))
  })

  test('rejects an end that is not a dateTime', () => {
    expect(() => decode({ end: 'not a date' })).toThrow()
  })
})
