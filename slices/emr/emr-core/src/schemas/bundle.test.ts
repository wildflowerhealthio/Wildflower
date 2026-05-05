import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Bundle } from './bundle.ts'

const TestBundle = Bundle.Schema(Schema.String)

// ---------------------------------------------------------------------------
// `TestBundle.identifier` carries the Reference→Identifier cycle.
// `link` and `signature` are typed `Schema.Any`, whose default arbitrary
// produces a wide mix of JSON values that's expensive to walk; those get
// reduced numRuns. See `identifier-and-reference.test.ts` for the rationale
// on the `AnyNoContext` cast.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = 25
const ANY_NUM_RUNS = 25

const roundTripField = (name: keyof typeof TestBundle.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = TestBundle.pick(name) as unknown as Schema.Schema.AnyNoContext
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

const fieldCases: readonly {
  readonly name: keyof typeof TestBundle.Type
  readonly numRuns?: number
}[] = [
  { name: 'type' },
  { name: 'entry' },
  { name: 'id' },
  { name: 'implicitRules' },
  { name: 'language' },
  { name: 'timestamp' },
  { name: 'total' },
  { name: 'resourceType' },
  // Reference cycle:
  { name: 'identifier', numRuns: REFERENCE_NUM_RUNS },
  // Meta carries Coding[] (capped at the schema layer); still expensive
  // enough to trip the 5s default.
  { name: 'meta', numRuns: REFERENCE_NUM_RUNS },
  // Schema.Any-bearing fields:
  { name: 'link', numRuns: ANY_NUM_RUNS },
  { name: 'signature', numRuns: ANY_NUM_RUNS },
]

describe('Bundle resource', () => {
  test.each(fieldCases)(
    'property: $name field round-trips',
    ({ name, numRuns }) => roundTripField(name, numRuns),
    20_000
  )
})
