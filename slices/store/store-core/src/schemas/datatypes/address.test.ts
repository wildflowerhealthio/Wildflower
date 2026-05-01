import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Address from './address.ts'

const addressArb = Arbitrary.make(Address.Schema)

describe('Address model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(addressArb, (address) => {
        const encoded = Schema.encodeSync(Address.Schema)(address)
        const decoded = Schema.decodeSync(Address.Schema)(encoded)
        expect(decoded).toSchemaEqual(Address.Schema, address)
      })
    )
  })
})
