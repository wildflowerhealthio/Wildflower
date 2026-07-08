import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as CodeableConcept from './codeable-concept.ts'

describe('FhirR4CodeableConcept', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(CodeableConcept.Schema), (codeableConcept) => {
        const fhir = Schema.encodeSync(CodeableConcept.Schema)(codeableConcept)
        const decoded = Schema.decodeSync(CodeableConcept.Schema)(fhir)
        expect(decoded).toSchemaEqual(CodeableConcept.Schema, codeableConcept)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
