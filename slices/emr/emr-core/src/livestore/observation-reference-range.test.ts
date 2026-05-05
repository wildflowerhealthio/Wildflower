import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as ObservationReferenceRange from './observation-reference-range.ts'

const ReferenceRangeSchema = ObservationReferenceRange.Schema

describe('ObservationReferenceRange model', () => {
  test('ObservationReferenceRange.ResourceType is "ObservationReferenceRange"', () => {
    expect(ObservationReferenceRange.ResourceType).toBe('ObservationReferenceRange')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(Arbitrary.make(ReferenceRangeSchema), (rr) => {
        const encoded = Schema.encodeSync(ReferenceRangeSchema)(rr)
        const decoded = Schema.decodeSync(ReferenceRangeSchema)(encoded)
        expect(decoded).toSchemaEqual(ReferenceRangeSchema, rr)
      })
    )
  }, 10_000)

  // -------------------------------------------------------------------------
  // Per-field round-trips. Every field is required and uses `NullOr` (not
  // `Schema.optional`), so every key is always present and `JSON.stringify`
  // never strips it. This guards against regressing back to a shape where a
  // missing/undefined key would round-trip asymmetrically.
  // -------------------------------------------------------------------------
  const fieldNames = ['age', 'appliesTo', 'high', 'low', 'text', 'type'] as const

  test.each(fieldNames)('property: %s field round-trips', (fieldName) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pick erases no-context tracking through suspend
    const sub = ReferenceRangeSchema.pick(fieldName) as unknown as Schema.Schema.AnyNoContext
    fc.assert(
      fc.property(Arbitrary.make(sub), (value) => {
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
        const encoded = Schema.encodeSync(sub)(value)
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
        const decoded = Schema.decodeSync(sub)(encoded)
        expect(decoded).toSchemaEqual(sub, value)
      }),
      { numRuns: 25 }
    )
  })

  test('JSON round-trip preserves a fully-null reference range', () => {
    const value = Schema.decodeSync(ReferenceRangeSchema)({
      id: null,
      extension: [],
      modifierExtension: [],
      age: null,
      appliesTo: [],
      high: null,
      low: null,
      text: null,
      type: null,
    })
    const encoded = Schema.encodeSync(ReferenceRangeSchema)(value)
    const reparsed: unknown = JSON.parse(JSON.stringify(encoded))
    const decoded = Schema.decodeUnknownSync(ReferenceRangeSchema)(reparsed)
    expect(decoded).toSchemaEqual(ReferenceRangeSchema, value)
  })

  test('decode rejects missing nullable keys', () => {
    const result = Schema.decodeUnknownEither(ReferenceRangeSchema)({
      id: null,
      extension: [],
      modifierExtension: [],
      appliesTo: [],
      // age, high, low, text, type all missing — must fail now that they are required NullOr fields
    })
    expect(result._tag).toBe('Left')
  })
})
