import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import type { Extension, ExtensionEncoded } from '../special-purpose/extension.ts'
import { Element } from './element.ts'

// ---------------------------------------------------------------------------
// Element tests
// ---------------------------------------------------------------------------

const TestElementElement = Element('TestElement')

class TestElement extends TestElementElement.extend<TestElement>('TestElement')({}) {
  static readonly ResourceType = TestElementElement.ResourceType
  static readonly IdSchema = TestElementElement.IdSchema
}

describe('Element', () => {
  describe('types', () => {
    test('Type.resourceType is the literal domain type string', () => {
      expectTypeOf<(typeof TestElement)['Type']['resourceType']>().toEqualTypeOf<'TestElement'>()
    })

    test('Encoded.resourceType is optional (defaults on decode)', () => {
      expectTypeOf<typeof TestElement.Encoded.resourceType>().toEqualTypeOf<
        'TestElement' | undefined
      >()
    })

    test('Type.extension items are Extension<V> — carries value types', () => {
      type ExtItem = (typeof TestElement.Type.extension)[number]
      expectTypeOf<ExtItem>().toExtend<Extension>()
    })

    test('Encoded.extension items are ExtensionEncoded<V>', () => {
      type EncExt = NonNullable<typeof TestElement.Encoded.extension>
      type EncExtItem = EncExt extends readonly (infer T)[] ? T : never
      expectTypeOf<EncExtItem>().toExtend<ExtensionEncoded>()
    })
  })

  test('decodes minimal input — resourceType and extension default', () => {
    const decoded = Schema.decodeSync(TestElement)({})
    expect(decoded.resourceType).toBe('TestElement')
    expect(decoded.extension).toEqual([])
    expect(decoded.id).toBeUndefined()
  })

  test('resourceType literal is accessible on the Element result', () => {
    expect(TestElement.ResourceType).toBe('TestElement')
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestElement)
    fc.assert(
      fc.property(arb, (element) => {
        const encoded = Schema.encodeSync(TestElement)(element)
        const decoded = Schema.decodeSync(TestElement)(encoded)
        expect(decoded).toSchemaEqual(element)
      })
    )
  })
})
