import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as ContactPoint from './contact-point.ts'

const contactPointArb = Arbitrary.make(ContactPoint.ContactPoint)

describe('ContactPoint model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(contactPointArb, (contactPoint) => {
        const encoded = Schema.encodeSync(ContactPoint.ContactPoint)(contactPoint)
        const decoded = Schema.decodeSync(ContactPoint.ContactPoint)(encoded)
        expect(decoded).toSchemaEqual(contactPoint)
      })
    )
  })
})
