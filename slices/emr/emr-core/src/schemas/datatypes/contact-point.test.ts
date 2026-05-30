import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as ContactPoint from './contact-point.ts'

const contactPointArb = Arbitrary.make(ContactPoint.Schema)

describe('ContactPoint model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(contactPointArb, (contactPoint) => {
        const encoded = Schema.encodeSync(ContactPoint.Schema)(contactPoint)
        const decoded = Schema.decodeSync(ContactPoint.Schema)(encoded)
        expect(decoded).toSchemaEqual(ContactPoint.Schema, contactPoint)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
