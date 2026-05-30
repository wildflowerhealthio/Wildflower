import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as SampledData from './sampled-data.ts'

const sampledDataArb = Arbitrary.make(SampledData.Schema)

describe('SampledData model', () => {
  test('SampledData.ResourceType is "SampledData"', () => {
    expect(SampledData.ResourceType).toBe('SampledData')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(sampledDataArb, (sample) => {
        const encoded = Schema.encodeSync(SampledData.Schema)(sample)
        const decoded = Schema.decodeSync(SampledData.Schema)(encoded)
        expect(decoded).toSchemaEqual(SampledData.Schema, sample)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
