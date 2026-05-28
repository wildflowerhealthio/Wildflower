import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Range as StoreRange } from 'emr-core/schemas'

import * as Range from './range.ts'

describe('FhirR4Range', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreRange.Schema), (range) => {
        const fhir = Schema.encodeSync(Range.Schema)(range)
        const decoded = Schema.decodeSync(Range.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreRange.Schema, range)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
