import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as HumanName from './human-name.ts'

const humanNameArb = Arbitrary.make(HumanName.HumanName)

describe('HumanName model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(humanNameArb, (humanName) => {
        const encoded = Schema.encodeSync(HumanName.HumanName)(humanName)
        const decoded = Schema.decodeSync(HumanName.HumanName)(encoded)
        expect(decoded).toSchemaEqual(humanName)
      })
    )
  })
})
