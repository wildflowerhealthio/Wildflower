import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Schema as TestElementSchema } from './element.ts'
import type { Schema as ExtensionSchema } from './extension.ts'

// ---------------------------------------------------------------------------
// Element tests
// ---------------------------------------------------------------------------

describe('Element', () => {
  describe('types', () => {
    test('Type.extension items are Extension — carries value types', () => {
      type T = Schema.Schema.Type<typeof TestElementSchema>
      type ExtItem = T['extension'][number]
      expectTypeOf<ExtItem>().toExtend<typeof ExtensionSchema.Type>()
    })

    test('Encoded.extension items are ExtensionEncoded', () => {
      type Enc = Schema.Schema.Encoded<typeof TestElementSchema>
      type EncExt = NonNullable<Enc['extension']>
      type EncExtItem = EncExt extends readonly (infer T)[] ? T : never
      expectTypeOf<EncExtItem>().toExtend<typeof ExtensionSchema.Encoded>()
    })
  })

  test('decodes minimal input — resourceType and extension default', () => {
    const decoded = Schema.decodeSync(TestElementSchema)({
      id: null,
      extension: [],
    })
    expect(decoded.extension).toEqual([])
    expect(decoded.id).toBe(null)
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestElementSchema)
    fc.assert(
      fc.property(arb, (element) => {
        const encoded = Schema.encodeSync(TestElementSchema)(element)
        const decoded = Schema.decodeSync(TestElementSchema)(encoded)
        expect(decoded).toSchemaEqual(TestElementSchema, element)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
