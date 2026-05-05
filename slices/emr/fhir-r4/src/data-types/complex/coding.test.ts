import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Coding as StoreCoding } from 'emr-core/schemas'

import * as Coding from './coding.ts'

describe('FhirR4Coding', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreCoding.Schema), (coding) => {
        const fhir = Schema.encodeSync(Coding.Schema)(coding)
        const decoded = Schema.decodeSync(Coding.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreCoding.Schema, coding)
      })
    )
  })
})
