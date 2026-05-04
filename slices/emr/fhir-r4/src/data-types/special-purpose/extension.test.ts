import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Extension as StoreExtension } from 'emr-core/schemas'

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
})
