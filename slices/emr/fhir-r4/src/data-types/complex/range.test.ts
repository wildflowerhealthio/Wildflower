import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Range from './range.ts'

describe('FhirR4Range', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Range.Schema), (range) => {
        const fhir = Schema.encodeSync(Range.Schema)(range)
        const decoded = Schema.decodeSync(Range.Schema)(fhir)
        expect(decoded).toSchemaEqual(Range.Schema, range)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
