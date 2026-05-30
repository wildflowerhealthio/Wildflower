import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { SimpleQuantity as StoreSimpleQuantity } from 'emr-core/schemas'

import * as SimpleQuantity from './simple-quantity.ts'

describe('FhirR4SimpleQuantity', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreSimpleQuantity.Schema), (quantity) => {
        const fhir = Schema.encodeSync(SimpleQuantity.Schema)(quantity)
        const decoded = Schema.decodeSync(SimpleQuantity.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreSimpleQuantity.Schema, quantity)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
