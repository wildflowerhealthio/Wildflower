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

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(observationArb, (obs) => {
        const encoded = Schema.encodeSync(ObservationSchema)(obs)
        const decoded = Schema.decodeSync(ObservationSchema)(encoded)
        expect(decoded).toSchemaEqual(ObservationSchema, obs)
      })
    )
  })

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
