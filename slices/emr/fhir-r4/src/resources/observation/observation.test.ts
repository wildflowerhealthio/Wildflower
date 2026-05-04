import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Observation as StoreObservation } from 'emr-core/livestore'

import * as Observation from './observation.ts'

describe('FhirR4Observation', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreObservation.RowSchema), (observation) => {
        const fhir = Schema.encodeSync(Observation.Schema)(observation)
        const decoded = Schema.decodeSync(Observation.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreObservation.RowSchema, observation)
      })
    )
  })
})
