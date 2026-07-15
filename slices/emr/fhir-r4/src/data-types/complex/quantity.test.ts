import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Quantity from './quantity.ts'
import * as SimpleQuantity from './simple-quantity.ts'

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

describe('Quantity.fromSimpleQuantity', () => {
  test('property: widening preserves shared fields, brands code, and adds a null comparator', () => {
    fc.assert(
      fc.property(Arbitrary.make(SimpleQuantity.Schema), (simple) => {
        const widened = Quantity.fromSimpleQuantity(simple)

        expect(widened.comparator).toBeNull()
        expect(widened.value).toBe(simple.value)
        expect(widened.unit).toBe(simple.unit)
        expect(widened.system).toBe(simple.system)
        // The FHIR `code` brand is a runtime no-op, so the underlying string is unchanged.
        expect(widened.code).toBe(simple.code)
        // The widened value is a valid R4 Quantity.
        expect(() => Schema.encodeSync(Quantity.Schema)(widened)).not.toThrow()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
