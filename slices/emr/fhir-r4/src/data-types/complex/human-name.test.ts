import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { HumanName as StoreHumanName } from 'emr-core/schemas'

import * as HumanName from './human-name.ts'

describe('FhirR4HumanName', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreHumanName.Schema), (humanName) => {
        const fhir = Schema.encodeSync(HumanName.Schema)(humanName)
        const decoded = Schema.decodeSync(HumanName.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreHumanName.Schema, humanName)
      })
    )
  })
})
