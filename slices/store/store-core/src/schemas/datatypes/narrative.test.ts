import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Narrative from './narrative.ts'

const narrativeArb = Arbitrary.make(Narrative.Schema)

describe('Narrative model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(narrativeArb, (narrative) => {
        const encoded = Schema.encodeSync(Narrative.Schema)(narrative)
        const decoded = Schema.decodeSync(Narrative.Schema)(encoded)
        expect(decoded).toSchemaEqual(Narrative.Schema, narrative)
      })
    )
  })
})
