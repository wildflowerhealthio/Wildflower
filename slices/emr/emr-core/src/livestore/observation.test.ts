import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Observation from './observation.ts'

const ObservationSchema = Observation.RowSchema

// ---------------------------------------------------------------------------
// Decomposed round-trip — see `patient.test.ts` for the rationale on the
// per-column pick approach, the `AnyNoContext` cast, and the smaller
// `numRuns` budget for cycle-bearing columns.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = numRunsFor({ base: 25 })

const roundTripColumn = (name: keyof typeof ObservationSchema.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = ObservationSchema.pick(name) as unknown as Schema.Schema.AnyNoContext
  fc.assert(
    fc.property(Arbitrary.make(sub), (value) => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
      const encoded = Schema.encodeSync(sub)(value)
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
      const decoded = Schema.decodeSync(sub)(encoded)
      expect(decoded).toSchemaEqual(sub, value)
    }),
    { numRuns }
  )
}

interface ColumnCase {
  readonly name: keyof typeof ObservationSchema.Type
  readonly numRuns?: number
}

const columnCases: readonly ColumnCase[] = [
  { name: 'code' },
  { name: 'status' },
  { name: 'category' },
  { name: 'interpretation' },
  { name: 'bodySite' },
  { name: 'dataAbsentReason' },
  // CodeableConcept (with Coding[] capped) + the encode+decode normalisation
  // pass below still pushes these past the 5s default; budget reduced.
  { name: 'method', numRuns: REFERENCE_NUM_RUNS },
  // ObservationReferenceRange has CodeableConcept-bearing fields plus
  // Quantity/Range. Reduced budget keeps the test under 5s.
  { name: 'referenceRange', numRuns: REFERENCE_NUM_RUNS },
  { name: 'component', numRuns: REFERENCE_NUM_RUNS },
  { name: 'effectiveDateTime' },
  { name: 'effectivePeriod' },
  { name: 'effectiveTiming' },
  { name: 'effectiveInstant' },
  { name: 'issued' },
  { name: 'language' },
  { name: 'implicitRules' },
  { name: 'meta' },
  { name: 'resourceType' },
  { name: 'identifier', numRuns: REFERENCE_NUM_RUNS },
  { name: 'note', numRuns: REFERENCE_NUM_RUNS },
  { name: 'basedOn', numRuns: REFERENCE_NUM_RUNS },
  { name: 'derivedFrom', numRuns: REFERENCE_NUM_RUNS },
  { name: 'focus', numRuns: REFERENCE_NUM_RUNS },
  { name: 'hasMember', numRuns: REFERENCE_NUM_RUNS },
  { name: 'partOf', numRuns: REFERENCE_NUM_RUNS },
  { name: 'performer', numRuns: REFERENCE_NUM_RUNS },
  { name: 'subject', numRuns: REFERENCE_NUM_RUNS },
  { name: 'encounter', numRuns: REFERENCE_NUM_RUNS },
  { name: 'device', numRuns: REFERENCE_NUM_RUNS },
  { name: 'specimen', numRuns: REFERENCE_NUM_RUNS },
  { name: 'valueQuantity' },
  { name: 'valueCodeableConcept' },
  { name: 'valueString' },
  { name: 'valueBoolean' },
  { name: 'valueInteger' },
  { name: 'valueRange' },
  { name: 'valueRatio' },
  { name: 'valueSampledData' },
  { name: 'valueTime' },
  { name: 'valueDateTime' },
  { name: 'valuePeriod' },
]

describe('Observation model', () => {
  test('Observation.resourceType is "Observation"', () => {
    expect(Observation.resourceType).toBe('Observation')
  })

  test.each(columnCases)(
    'property: $name column round-trips',
    ({ name, numRuns }) => roundTripColumn(name, numRuns),
    10_000
  )

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
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})
