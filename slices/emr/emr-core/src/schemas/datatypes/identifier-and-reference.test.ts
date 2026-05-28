import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Identifier from './identifier.ts'
import * as Reference from './reference.ts'

// ---------------------------------------------------------------------------
// Reference embeds Identifier (which embeds Reference back via `assigner`).
// `Identifier.assigner` is pinned to `null` at the arbitrary layer so the
// cycle terminates at depth 2, but each iteration of a full-schema property
// test still walks the entire Reference + Identifier graph.
//
// We decompose into per-field sub-schema round-trips: `Schema.pick(field)`
// produces a Schema for just that field, and we round-trip that sub-schema
// directly. The mutual cycle is exercised explicitly in `cycles.test.ts`.
//
// `AnyNoContext` cast: `Schema.Struct.pick(...)` doesn't always propagate
// the no-context constraint when fields reach `Schema.suspend(...)`; at
// runtime every schema is no-context, so the cast is sound.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = numRunsFor(25)

const roundTripReferenceField = (
  name: keyof typeof Reference.Schema.Type,
  numRuns?: number
): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = Reference.Schema.pick(name) as unknown as Schema.Schema.AnyNoContext
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

const roundTripIdentifierField = (
  name: keyof typeof Identifier.Schema.Type,
  numRuns?: number
): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = Identifier.Schema.pick(name) as unknown as Schema.Schema.AnyNoContext
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

const referenceCases: readonly {
  readonly name: keyof typeof Reference.Schema.Type
  readonly numRuns?: number
}[] = [
  { name: 'display' },
  { name: 'reference' },
  { name: 'type' },
  { name: 'id' },
  { name: 'extension' },
  // Reference→Identifier cycle inflates per-iteration cost.
  { name: 'identifier', numRuns: REFERENCE_NUM_RUNS },
]

const identifierCases: readonly {
  readonly name: keyof typeof Identifier.Schema.Type
  readonly numRuns?: number
}[] = [
  { name: 'system' },
  { name: 'value' },
  { name: 'use' },
  { name: 'period' },
  { name: 'assigner' }, // capped to null at the arbitrary layer
  { name: 'id' },
  { name: 'extension' },
  // Identifier.type → CodeableConcept (with Coding[] cap applied at the
  // schema layer); still expensive enough that 100 runs trips the default.
  { name: 'type', numRuns: REFERENCE_NUM_RUNS },
]

describe('Reference model', () => {
  test('Reference.ResourceType is "Reference"', () => {
    expect(Reference.ResourceType).toBe('Reference')
  })

  test.each(referenceCases)(
    'property: $name field round-trips',
    ({ name, numRuns }) => roundTripReferenceField(name, numRuns),
    10_000
  )

  describe('fromResource', () => {
    test('returns a Reference when url is present', () => {
      const url = 'https://example.com/TestResource/456'
      const result = Reference.fromResource({
        meta: { source: url },
        resourceType: 'TestResource',
      })
      expect(result).toBeDefined()
      expect(result?.type).toBe('TestResource')
      expect(result?.reference).toBe('https://example.com/TestResource/456')
    })

    test('returns a Reference with display when provided', () => {
      const url = 'https://example.com/TestResource/456'
      const result = Reference.fromResource(
        { meta: { source: url }, resourceType: 'TestResource' },
        'Test Display'
      )
      expect(result).toBeDefined()
      expect(result?.display).toBe('Test Display')
    })

    test('returns undefined when meta.source is undefined', () => {
      const result = Reference.fromResource({
        meta: { source: undefined },
        resourceType: 'TestResource',
      })
      expect(result).toBeUndefined()
    })
  })
})

describe('Identifier model', () => {
  test('Identifier.ResourceType is "Identifier"', () => {
    expect(Identifier.ResourceType).toBe('Identifier')
  })

  test.each(identifierCases)(
    'property: $name field round-trips',
    ({ name, numRuns }) => roundTripIdentifierField(name, numRuns),
    10_000
  )
})
