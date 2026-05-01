import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as SimpleQuantity from './simple-quantity.ts'

const quantityArb = Arbitrary.make(SimpleQuantity.Schema)

describe('SimpleQuantity model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(quantityArb, (quantity) => {
        const encoded = Schema.encodeSync(SimpleQuantity.Schema)(quantity)
        const decoded = Schema.decodeSync(SimpleQuantity.Schema)(encoded)
        expect(decoded).toSchemaEqual(SimpleQuantity.Schema, quantity)
      })
    )
  })
})
