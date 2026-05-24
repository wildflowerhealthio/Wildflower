import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Address as StoreAddress, Extension as StoreExtension } from 'emr-core/schemas'

// side-effect: load Address so the registry's `valueAddress` slot resolves
import '../complex/address.ts'
import * as Extension from './extension.ts'

describe('FhirR4Extension', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(StoreExtension.Schema).map((ext) => ({ ...ext, extension: [] })),
        (extension) => {
          const fhir = Schema.encodeSync(Extension.Schema)(extension)
          const decoded = Schema.decodeSync(Extension.Schema)(fhir)
          expect(decoded).toSchemaEqual(StoreExtension.Schema, extension)
        }
      )
    )
  })

  test('encodes null choice fields to undefined, not null, on the wire', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreAddress.Schema), (address) => {
        const storeExtension: typeof StoreExtension.Schema.Type = {
          ...StoreExtension.emptyValueChoice,
          id: null,
          extension: [],
          url: 'http://example.org/ext/home-address',
          valueAddress: address,
        }
        const encoded = Schema.encodeSync(Extension.Schema)(storeExtension)
        const decoded = Schema.decodeSync(Extension.Schema)(encoded)
        expect(decoded).toSchemaEqual(StoreExtension.Schema, storeExtension)
      })
    )
  })
})
