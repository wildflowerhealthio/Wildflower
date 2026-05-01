import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Observation from './observation.ts'

const ObservationSchema = Observation.RowSchema

const observationArb = Arbitrary.make(ObservationSchema)

describe('Observation model', () => {
  test('Observation.resourceType is "Observation"', () => {
    expect(Observation.resourceType).toBe('Observation')
  })

  // Observation's RowSchema fans out the value[x] choice element across many
  // primitive and complex datatypes, so 100 fast-check iterations of full
  // encode/decode round-trips runs ~5s solo and grows several-fold under the
  // CPU contention of `vp run -r test`. Bumped well past the 5s default to
  // absorb worst-case worker-contention slowdown — the other property tests
  // sit at 15s; this one is the genuine outlier in the suite.
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(observationArb, (obs) => {
        const encoded = Schema.encodeSync(ObservationSchema)(obs)
        const decoded = Schema.decodeSync(ObservationSchema)(encoded)
        expect(decoded).toSchemaEqual(ObservationSchema, obs)
      })
    )
  }, 45_000)

  test('property: missing required fields always fail', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Missing status
          fc.record({
            code: fc.record({ text: fc.string() }),
            resourceType: fc.constant('Observation' as const),
            id: fc.string(),
          }),
          // Missing code
          fc.record({
            resourceType: fc.constant('Observation' as const),
            status: fc.constantFrom('final', 'preliminary'),
            id: fc.string(),
          })
        ),
        (incomplete) => {
          const decode = Schema.decodeUnknownEither(ObservationSchema)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: 20 }
    )
  })
})
