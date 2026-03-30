import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Range from './range.ts'

const rangeArb = Arbitrary.make(Range.Range)

describe('Range model', () => {
  test('Range.ResourceType is "Range"', () => {
    expect(Range.Range.ResourceType).toBe('Range')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(rangeArb, (range) => {
        const encoded = Schema.encodeSync(Range.Range)(range)
        const decoded = Schema.decodeSync(Range.Range)(encoded)
        expect(decoded).toSchemaEqual(range)
      })
    )
  })
})
