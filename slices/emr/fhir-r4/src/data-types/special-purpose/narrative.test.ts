import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Narrative as StoreNarrative } from 'emr-core/schemas'

import * as Narrative from './narrative.ts'

describe('FhirR4Narrative', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreNarrative.Schema), (narrative) => {
        const fhir = Schema.encodeSync(Narrative.Schema)(narrative)
        const decoded = Schema.decodeSync(Narrative.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreNarrative.Schema, narrative)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
