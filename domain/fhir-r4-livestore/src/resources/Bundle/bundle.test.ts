import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Bundle } from './bundle.ts'

// Create a concrete Bundle type for testing
const TestBundle = Bundle.Schema(Schema.String)

const bundleArb = Arbitrary.make(TestBundle)

describe('Bundle resource', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(bundleArb, (bundle) => {
        const encoded = Schema.encodeSync(TestBundle)(bundle)
        const decoded = Schema.decodeSync(TestBundle)(encoded)
        expect(decoded).toSchemaEqual(bundle)
      })
    )
  })
})
