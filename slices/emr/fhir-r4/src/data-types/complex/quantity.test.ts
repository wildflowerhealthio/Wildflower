import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Quantity from './quantity.ts'

describe('FhirR4Quantity', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Quantity.Schema), (quantity) => {
        const fhir = Schema.encodeSync(Quantity.Schema)(quantity)
        const decoded = Schema.decodeSync(Quantity.Schema)(fhir)
        expect(decoded).toSchemaEqual(Quantity.Schema, quantity)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
