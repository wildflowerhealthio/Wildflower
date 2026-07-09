import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as HumanName from './human-name.ts'

describe('FhirR4HumanName', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(HumanName.Schema), (humanName) => {
        const fhir = Schema.encodeSync(HumanName.Schema)(humanName)
        const decoded = Schema.decodeSync(HumanName.Schema)(fhir)
        expect(decoded).toSchemaEqual(HumanName.Schema, humanName)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
