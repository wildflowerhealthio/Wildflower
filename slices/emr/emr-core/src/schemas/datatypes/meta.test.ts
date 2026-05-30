import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Meta from './meta.ts'

const metaArb = Arbitrary.make(Meta.Schema)

describe('Meta base model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(metaArb, (resource) => {
        const encoded = Schema.encodeSync(Meta.Schema)(resource)
        const decoded = Schema.decodeSync(Meta.Schema)(encoded)
        expect(decoded).toSchemaEqual(Meta.Schema, resource)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
