import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as Resource from './resource.ts'

describe('Resource', () => {
  describe('types', () => {
    test('Type does not have DomainResource fields', () => {
      type T = Schema.Schema.Type<typeof Resource.Schema>
      expectTypeOf<T>().not.toHaveProperty('text')
      expectTypeOf<T>().not.toHaveProperty('contained')
      expectTypeOf<T>().not.toHaveProperty('extension')
      expectTypeOf<T>().not.toHaveProperty('modifierExtension')
    })
  })

  test('decodes minimal input — defaults apply', () => {
    const decoded = Schema.decodeSync(Resource.Schema)({
      meta: null,
      implicitRules: null,
      language: null,
    })

    expect(decoded.meta).toBeNull()
    expect(decoded.language).toBeNull()
    expect(decoded.implicitRules).toBeNull()
  })

  test('property: encode-decode round-trip', () => {
    const arb = Arbitrary.make(Resource.Schema)
    fc.assert(
      fc.property(arb, (resource) => {
        const encoded = Schema.encodeSync(Resource.Schema)(resource)
        const decoded = Schema.decodeSync(Resource.Schema)(encoded)
        expect(decoded).toSchemaEqual(Resource.Schema, resource)
      })
    )
  })
})
