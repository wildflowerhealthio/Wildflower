import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Annotation as StoreAnnotation } from 'emr-core/schemas'

import * as Annotation from './annotation.ts'

describe('FhirR4Annotation', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreAnnotation.Schema), (annotation) => {
        const fhir = Schema.encodeSync(Annotation.Schema)(annotation)
        const decoded = Schema.decodeSync(Annotation.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreAnnotation.Schema, annotation)
      })
    )
  })
})
