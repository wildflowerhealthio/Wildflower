import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Meta } from './meta.ts'
import type { MetaEncoded } from './meta.ts'

const metaArb = Arbitrary.make(Meta)

describe('Meta base model', () => {
  test('should encode to encoded type', () => {
    expectTypeOf<MetaEncoded>().toExtend<typeof Meta.Encoded>()
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(metaArb, (resource) => {
        const encoded = Schema.encodeSync(Meta)(resource)
        const decoded = Schema.decodeSync(Meta)(encoded)
        expect(decoded).toSchemaEqual(resource)
      })
    )
  })
})
