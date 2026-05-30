import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Binary from './binary.ts'

const BinarySchema = Binary.RowSchema

// ---------------------------------------------------------------------------
// Decomposed round-trip — see `patient.test.ts` for rationale.
//
// Note: `BinarySchema.pick('data')` would inherit Effect's default arbitrary
// for `Base64FromUint8ArrayBuffer`, which produces strings that don't always
// decode. We test the data column with an explicit `fc.uint8Array()`-seeded
// arbitrary instead.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = numRunsFor({ base: 25 })

const roundTripColumn = (name: keyof typeof BinarySchema.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = BinarySchema.pick(name) as unknown as Schema.Schema.AnyNoContext
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

const columnCases: readonly {
  readonly name: keyof typeof BinarySchema.Type
  readonly numRuns?: number
}[] = [
  { name: 'contentType' },
  { name: 'language' },
  { name: 'implicitRules' },
  { name: 'meta' },
  { name: 'resourceType' },
  // securityContext is a Reference — Reference→Identifier cycle.
  { name: 'securityContext', numRuns: REFERENCE_NUM_RUNS },
]

describe('Binary model', () => {
  test('Binary.resourceType is "Binary"', () => {
    expect(Binary.resourceType).toBe('Binary')
  })

  test.each(columnCases)(
    'property: $name column round-trips',
    ({ name, numRuns }) => roundTripColumn(name, numRuns),
    10_000
  )

  test('property: data column round-trips', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
    const sub = BinarySchema.pick('data') as unknown as Schema.Schema.AnyNoContext
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        const data = Schema.encodeSync(Schema.Uint8ArrayFromBase64)(bytes)
        const value = { data }
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
        const encoded = Schema.encodeSync(sub)(value)
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
        const decoded = Schema.decodeSync(sub)(encoded)
        expect(decoded).toSchemaEqual(sub, value)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: missing required fields always fail', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Wrong resourceType
          fc.record({
            resourceType: fc.constant('Patient' as const),
            id: fc.string(),
          }),
          // Missing contentType
          fc.record({
            resourceType: fc.constant('Binary' as const),
            id: fc.string(),
          })
        ),
        (incomplete) => {
          const decode = Schema.decodeUnknownEither(BinarySchema)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('BinarySchema decodes successfully when id is present', () => {
    const payload: typeof BinarySchema.Encoded = {
      resourceType: 'Binary',
      id: 'bin-001',
      contentType: 'application/pdf',
      data: new Uint8Array([1, 2, 3, 4]),
      securityContext: null,
      text: null,
      contained: '[]',
      extension: '[]',
      modifierExtension: '[]',
      meta: null,
      implicitRules: null,
      language: null,
    }
    const result = Schema.decodeUnknownEither(BinarySchema)(payload)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.id).toBe('bin-001')
      expect(result.right.contentType).toBe('application/pdf')
    }
  })

  test('BinarySchema fails when id is missing', () => {
    const payload = {
      resourceType: 'Binary',
      contentType: 'application/pdf',
    }
    const result = Schema.decodeUnknownEither(BinarySchema)(payload)
    expect(Either.isLeft(result)).toBe(true)
  })
})
