import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Quantity from './quantity.ts'

const quantityArb = Arbitrary.make(Quantity.Schema)

describe('Quantity model', () => {
  test('Quantity.ResourceType is "Quantity"', () => {
    expect(Quantity.ResourceType).toBe('Quantity')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(quantityArb, (quantity) => {
        const encoded = Schema.encodeSync(Quantity.Schema)(quantity)
        const decoded = Schema.decodeSync(Quantity.Schema)(encoded)
        expect(decoded).toSchemaEqual(Quantity.Schema, quantity)
      }),
      { numRuns: numRunsFor(100) }
    )
  })
})
