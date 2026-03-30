import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import type { DeepReadonly } from 'kitchen-sink/types'
// import type { fhir4 } from 'fhir'
import { describe, expect, expectTypeOf, it, test } from 'vite-plus/test'
import { SimpleQuantity } from './simple-quantity.ts'

const quantityArb = Arbitrary.make(SimpleQuantity)

describe('SimpleQuantity model', () => {
  it('should have a FHIR R4 compatible type', () => {
    expectTypeOf<DeepReadonly<fhir4.Quantity>>().toExtend<SimpleQuantity>()
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(quantityArb, (quantity) => {
        const encoded = Schema.encodeSync(SimpleQuantity)(quantity)
        const decoded = Schema.decodeSync(SimpleQuantity)(encoded)
        expect(decoded).toSchemaEqual(quantity)
      })
    )
  })
})
