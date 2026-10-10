import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Duration from './duration.ts'

describe('FhirR4Duration', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Duration.Schema), (duration) => {
        const fhir = Schema.encodeSync(Duration.Schema)(duration)
        const decoded = Schema.decodeSync(Duration.Schema)(fhir)
        expect(decoded).toSchemaEqual(Duration.Schema, duration)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
