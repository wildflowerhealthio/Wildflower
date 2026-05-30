import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Ratio from './ratio.ts'

const ratioArb = Arbitrary.make(Ratio.Schema)

describe('Ratio model', () => {
  test('Ratio.ResourceType is "Ratio"', () => {
    expect(Ratio.ResourceType).toBe('Ratio')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(ratioArb, (ratio) => {
        const encoded = Schema.encodeSync(Ratio.Schema)(ratio)
        const decoded = Schema.decodeSync(Ratio.Schema)(encoded)
        expect(decoded).toSchemaEqual(Ratio.Schema, ratio)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
