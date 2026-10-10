import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Ratio from './ratio.ts'

describe('FhirR4Ratio', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Ratio.Schema), (ratio) => {
        const fhir = Schema.encodeSync(Ratio.Schema)(ratio)
        const decoded = Schema.decodeSync(Ratio.Schema)(fhir)
        expect(decoded).toSchemaEqual(Ratio.Schema, ratio)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
