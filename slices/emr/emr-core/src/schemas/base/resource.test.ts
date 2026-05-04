import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as Resource from './resource.ts'

// ---------------------------------------------------------------------------
// `meta` carries `security: Coding[]` and `tag: Coding[]` (capped at the
// schema layer). Decompose into per-field sub-schema round-trips. See
// `identifier-and-reference.test.ts` for rationale on the `AnyNoContext`
// cast.
// ---------------------------------------------------------------------------

const META_NUM_RUNS = 25

const roundTripField = (name: keyof typeof Resource.Schema.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = Resource.Schema.pick(name) as unknown as Schema.Schema.AnyNoContext
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
  readonly name: keyof typeof Resource.Schema.Type
  readonly numRuns?: number
}[] = [
  // Meta carries Coding[] arrays (capped at schema layer); still ~3-5x
  // costlier per iteration than other fields.
  { name: 'meta', numRuns: META_NUM_RUNS },
  { name: 'implicitRules' },
  { name: 'language' },
]

describe('Resource', () => {
  describe('types', () => {
    test('Type does not have DomainResource fields', () => {
      type T = Schema.Schema.Type<typeof Resource.Schema>
      expectTypeOf<T>().not.toHaveProperty('text')
      expectTypeOf<T>().not.toHaveProperty('contained')
      expectTypeOf<T>().not.toHaveProperty('extension')
      expectTypeOf<T>().not.toHaveProperty('modifierExtension')
    })
  })

  test('decodes minimal input — defaults apply', () => {
    const decoded = Schema.decodeSync(Resource.Schema)({
      meta: null,
      implicitRules: null,
      language: null,
    })

    expect(decoded.meta).toBeNull()
    expect(decoded.language).toBeNull()
    expect(decoded.implicitRules).toBeNull()
  })

  test.each(fieldCases)(
    'property: $name field round-trips',
    ({ name, numRuns }) => roundTripField(name, numRuns),
    10_000
  )
})
