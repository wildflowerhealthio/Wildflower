import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Timing from './timing.ts'

describe('FhirR4Timing', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Timing.Schema), (timing) => {
        const fhir = Schema.encodeSync(Timing.Schema)(timing)
        const decoded = Schema.decodeSync(Timing.Schema)(fhir)
        expect(decoded).toSchemaEqual(Timing.Schema, timing)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('UnitOfTimeSchema accepts exactly the UnitsOfTime codes', () => {
    const isUnitOfTime = Schema.is(Timing.UnitOfTimeSchema)
    for (const code of ['s', 'min', 'h', 'd', 'wk', 'mo', 'a']) {
      expect(isUnitOfTime(code)).toBe(true)
    }
    for (const code of ['day', 'D', 'y', '']) {
      expect(isUnitOfTime(code)).toBe(false)
    }
  })
})
