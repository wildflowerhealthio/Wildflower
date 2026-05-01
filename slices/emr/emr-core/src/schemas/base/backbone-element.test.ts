import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import type { Schema as ExtensionSchema } from '../datatypes/extension.ts'
import { Schema as TestBackboneSchema } from './backbone-element.ts'

describe('BackboneElement', () => {
  describe('types', () => {
    test('Type.modifierExtension is present', () => {
      expectTypeOf<Schema.Schema.Type<typeof TestBackboneSchema>['modifierExtension']>().toExtend<
        readonly (typeof ExtensionSchema.Type)[]
      >()
    })
  })

  test('decodes minimal input — extension, modifierExtension default', () => {
    const decoded = Schema.decodeSync(TestBackboneSchema)({
      id: null,
      extension: [],
      modifierExtension: [],
    })
    expect(decoded.extension).toHaveLength(0)
    expect(decoded.modifierExtension).toHaveLength(0)
    expect(decoded.id).toBeNull()
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestBackboneSchema)
    fc.assert(
      fc.property(arb, (element) => {
        const encoded = Schema.encodeSync(TestBackboneSchema)(element)
        const decoded = Schema.decodeSync(TestBackboneSchema)(encoded)
        expect(decoded).toSchemaEqual(TestBackboneSchema, element)
      })
    )
  })
})
