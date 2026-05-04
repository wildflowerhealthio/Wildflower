import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { ContactPoint as StoreContactPoint } from 'emr-core/schemas'

import * as ContactPoint from './contact-point.ts'

describe('FhirR4ContactPoint', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreContactPoint.Schema), (contactPoint) => {
        const fhir = Schema.encodeSync(ContactPoint.Schema)(contactPoint)
        const decoded = Schema.decodeSync(ContactPoint.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreContactPoint.Schema, contactPoint)
      })
    )
  })
})
