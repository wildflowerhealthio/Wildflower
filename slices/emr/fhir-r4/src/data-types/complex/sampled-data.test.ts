import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { SampledData as StoreSampledData } from 'emr-core/schemas'

import * as SampledData from './sampled-data.ts'

describe('FhirR4SampledData', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(StoreSampledData.Schema), (sample) => {
        const fhir = Schema.encodeSync(SampledData.Schema)(sample)
        const decoded = Schema.decodeSync(SampledData.Schema)(fhir)
        expect(decoded).toSchemaEqual(StoreSampledData.Schema, sample)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
