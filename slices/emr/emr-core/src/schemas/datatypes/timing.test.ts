import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Timing from './timing.ts'

const timingArb = Arbitrary.make(Timing.Schema)

// Timing carries a nested `TimingRepeat` (Element with `boundsPeriod` /
// `boundsRange` / multiple arrays) plus an `event: Array(InstantSchema)`,
// so the property assertion is heavier than a flat datatype. Reduced budget
// mirrors `REFERENCE_NUM_RUNS` in `observation.test.ts` to stay under the
// default per-test timeout when the suite runs in parallel.
const NUM_RUNS = numRunsFor({ base: 25 })

describe('Timing model', () => {
  test('Timing.ResourceType is "Timing"', () => {
    expect(Timing.ResourceType).toBe('Timing')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(timingArb, (timing) => {
        const encoded = Schema.encodeSync(Timing.Schema)(timing)
        const decoded = Schema.decodeSync(Timing.Schema)(encoded)
        expect(decoded).toSchemaEqual(Timing.Schema, timing)
      }),
      { numRuns: NUM_RUNS }
    )
  })
})
