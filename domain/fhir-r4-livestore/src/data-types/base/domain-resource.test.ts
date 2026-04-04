import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import type { Extension } from '../special-purpose/extension.ts'
import { DomainResource } from './domain-resource.ts'
import type { DomainResourceEncoded } from './domain-resource.ts'

const TestDomainResourceResource = DomainResource('TestDomainResource')

class TestDomainResource extends TestDomainResourceResource.extend<TestDomainResource>(
  'TestDomainResource'
)({}) {
  static readonly ResourceType = TestDomainResourceResource.ResourceType
  static readonly IdSchema = TestDomainResourceResource.IdSchema
}

describe('DomainResource', () => {
  describe('types', () => {
    test('Type.resourceType is the literal domain type string', () => {
      expectTypeOf<
        (typeof TestDomainResource)['Type']['resourceType']
      >().toEqualTypeOf<'TestDomainResource'>()
    })

    test('DomainResourceEncoded extends the Encoded type', () => {
      expectTypeOf<DomainResourceEncoded<'TestDomainResource'>>().toExtend<
        typeof TestDomainResource.Encoded
      >()
    })

    test('Type has all DomainResource fields', () => {
      type T = (typeof TestDomainResource)['Type']
      expectTypeOf<T['extension']>().toExtend<readonly Extension[]>()
      expectTypeOf<T['modifierExtension']>().toExtend<readonly Extension[]>()
      expectTypeOf<T['contained']>().toExtend<readonly unknown[]>()
    })

    test('Type has inherited Resource fields', () => {
      type T = (typeof TestDomainResource)['Type']
      expectTypeOf<T['resourceType']>().toEqualTypeOf<'TestDomainResource'>()
      expectTypeOf<T['meta']>().not.toEqualTypeOf<never>()
    })
  })

  test('decodes minimal input — defaults apply', () => {
    const decoded = Schema.decodeSync(TestDomainResource)({})
    expect(decoded.resourceType).toBe('TestDomainResource')
    expect(decoded.extension).toEqual([])
    expect(decoded.modifierExtension).toEqual([])
    expect(decoded.contained).toEqual([])
    expect(decoded.id).toBeUndefined()
    expect(decoded.meta).toBeUndefined()
    expect(decoded.text).toBeUndefined()
    expect(decoded.language).toBeUndefined()
    expect(decoded.implicitRules).toBeUndefined()
  })

  test('ResourceType static equals the domain type', () => {
    expect(TestDomainResource.ResourceType).toBe('TestDomainResource')
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestDomainResource)
    fc.assert(
      fc.property(arb, (resource) => {
        const encoded = Schema.encodeSync(TestDomainResource)(resource)
        const decoded = Schema.decodeSync(TestDomainResource)(encoded)
        expect(decoded).toSchemaEqual(resource)
      })
    )
  })
})
