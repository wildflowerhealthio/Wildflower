import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
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
})
