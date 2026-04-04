import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Quantity } from './quantity.ts'

const quantityArb = Arbitrary.make(Quantity)

describe('Quantity model', () => {
  test('Quantity.ResourceType is "Quantity"', () => {
    expect(Quantity.ResourceType).toBe('Quantity')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(quantityArb, (quantity) => {
        const encoded = Schema.encodeSync(Quantity)(quantity)
        const decoded = Schema.decodeSync(Quantity)(encoded)
        expect(decoded).toSchemaEqual(quantity)
      })
    )
  })
})
