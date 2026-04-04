import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Resource } from './resource.ts'
import type { ResourceEncoded } from './resource.ts'

const TestResourceResource = Resource('TestResource')

class TestResource extends TestResourceResource.extend<TestResource>('TestResource')({}) {
  static readonly ResourceType = TestResourceResource.ResourceType
  static readonly IdSchema = TestResourceResource.IdSchema
}

describe('Resource', () => {
  describe('types', () => {
    test('Type.resourceType is the literal domain type string', () => {
      expectTypeOf<(typeof TestResource)['Type']['resourceType']>().toEqualTypeOf<'TestResource'>()
    })

    test('ResourceEncoded extends the Encoded type', () => {
      expectTypeOf<ResourceEncoded<'TestResource'>>().toExtend<typeof TestResource.Encoded>()
    })

    test('Type does not have DomainResource fields', () => {
      type T = (typeof TestResource)['Type']
      expectTypeOf<T>().not.toHaveProperty('text')
      expectTypeOf<T>().not.toHaveProperty('contained')
      expectTypeOf<T>().not.toHaveProperty('extension')
      expectTypeOf<T>().not.toHaveProperty('modifierExtension')
    })
  })

  test('decodes minimal input — defaults apply', () => {
    const decoded = Schema.decodeSync(TestResource)({})
    expect(decoded.resourceType).toBe('TestResource')
    expect(decoded.id).toBeUndefined()
    expect(decoded.meta).toBeUndefined()
    expect(decoded.language).toBeUndefined()
    expect(decoded.implicitRules).toBeUndefined()
  })

  test('ResourceType static equals the domain type', () => {
    expect(TestResource.ResourceType).toBe('TestResource')
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(TestResource)
    fc.assert(
      fc.property(arb, (resource) => {
        const encoded = Schema.encodeSync(TestResource)(resource)
        const decoded = Schema.decodeSync(TestResource)(encoded)
        expect(decoded).toSchemaEqual(resource)
      })
    )
  })
})
