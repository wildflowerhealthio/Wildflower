import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Coding from './coding.ts'

describe('FhirR4Coding', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Coding.Schema), (coding) => {
        const fhir = Schema.encodeSync(Coding.Schema)(coding)
        const decoded = Schema.decodeSync(Coding.Schema)(fhir)
        expect(decoded).toSchemaEqual(Coding.Schema, coding)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
