import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Period from './period.ts'

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
})
