import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as SampledData from './sampled-data.ts'

describe('FhirR4SampledData', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(SampledData.Schema), (sample) => {
        const fhir = Schema.encodeSync(SampledData.Schema)(sample)
        const decoded = Schema.decodeSync(SampledData.Schema)(fhir)
        expect(decoded).toSchemaEqual(SampledData.Schema, sample)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
