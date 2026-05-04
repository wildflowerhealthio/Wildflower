import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Identifier as StoreIdentifier, Reference as StoreReference } from 'emr-core/schemas'

import { IdentifierSchema, ReferenceSchema } from './identifier-and-reference.ts'

describe('FhirR4Reference', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreReference.Schema), (reference) => {
        const fhir = Schema.encodeSync(ReferenceSchema)(reference)
        const decoded = Schema.decodeSync(ReferenceSchema)(fhir)
        expect(decoded).toSchemaEqual(StoreReference.Schema, reference)
      })
    )
  })
})

describe('FhirR4Identifier', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreIdentifier.Schema), (identifier) => {
        const fhir = Schema.encodeSync(IdentifierSchema)(identifier)
        const decoded = Schema.decodeSync(IdentifierSchema)(fhir)
        expect(decoded).toSchemaEqual(StoreIdentifier.Schema, identifier)
      })
    )
  })
})
