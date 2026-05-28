import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Annotation from './annotation.ts'

// ---------------------------------------------------------------------------
// Annotation has an `author[x]` choice (`authorString` / `authorReference`).
// `authorReference` walks the Reference→Identifier cycle. Decompose into
// per-field sub-schema round-trips. See `identifier-and-reference.test.ts`
// for the rationale on the `AnyNoContext` cast.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = numRunsFor(25)

const roundTripField = (name: keyof typeof Annotation.Schema.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = Annotation.Schema.pick(name) as unknown as Schema.Schema.AnyNoContext
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
  readonly name: keyof typeof Annotation.Schema.Type
  readonly numRuns?: number
}[] = [
  { name: 'text' },
  { name: 'time' },
  { name: 'authorString' },
  { name: 'id' },
  { name: 'extension' },
  // authorReference walks the Reference→Identifier cycle.
  { name: 'authorReference', numRuns: REFERENCE_NUM_RUNS },
]

describe('Annotation model', () => {
  test.each(fieldCases)(
    'property: $name field round-trips',
    ({ name, numRuns }) => roundTripField(name, numRuns),
    10_000
  )
})
