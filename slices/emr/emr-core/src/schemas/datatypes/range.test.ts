import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Range from './range.ts'

const rangeArb = Arbitrary.make(Range.Schema)

describe('Range model', () => {
  test('Range.ResourceType is "Range"', () => {
    expect(Range.ResourceType).toBe('Range')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(rangeArb, (range) => {
        const encoded = Schema.encodeSync(Range.Schema)(range)
        const decoded = Schema.decodeSync(Range.Schema)(encoded)
        expect(decoded).toSchemaEqual(Range.Schema, range)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
