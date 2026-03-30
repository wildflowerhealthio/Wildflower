import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import type { Extension } from '../special-purpose/extension.ts'
import { BackboneElement } from './backbone-element.ts'
import type { BackboneElementEncoded } from './backbone-element.ts'

const TestBackboneBackboneElement = BackboneElement('TestBackbone')

class TestBackbone extends TestBackboneBackboneElement.extend<TestBackbone>('TestBackbone')({}) {
  static readonly ResourceType = TestBackboneBackboneElement.ResourceType
  static readonly IdSchema = TestBackboneBackboneElement.IdSchema
}

describe('BackboneElement', () => {
  describe('types', () => {
    test('Type.resourceType is the literal domain type string', () => {
      expectTypeOf<(typeof TestBackbone)['Type']['resourceType']>().toEqualTypeOf<'TestBackbone'>()
    })

    test('BackboneElementEncoded extends the Encoded type', () => {
      expectTypeOf<BackboneElementEncoded<'TestBackbone'>>().toExtend<typeof TestBackbone.Encoded>()
    })

    test('Type.modifierExtension is present', () => {
      expectTypeOf<(typeof TestBackbone)['Type']['modifierExtension']>().toExtend<
        readonly Extension[]
      >()
    })
  })

  test('decodes minimal input — resourceType, extension, modifierExtension default', () => {
    const decoded = Schema.decodeSync(TestBackbone)({})
    expect(decoded.resourceType).toBe('TestBackbone')
    expect(decoded.extension).toHaveLength(0)
    expect(decoded.modifierExtension).toHaveLength(0)
    expect(decoded.id).toBeUndefined()
  })

  test('ResourceType static equals the domain type', () => {
    expect(TestBackbone.ResourceType).toBe('TestBackbone')
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestBackbone)
    fc.assert(
      fc.property(arb, (element) => {
        const encoded = Schema.encodeSync(TestBackbone)(element)
        const decoded = Schema.decodeSync(TestBackbone)(encoded)
        expect(decoded).toSchemaEqual(element)
      })
    )
  })
})
