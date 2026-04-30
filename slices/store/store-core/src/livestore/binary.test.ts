import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Binary from './binary.ts'

const BinarySchema = Binary.RowSchema

const binaryArb = Arbitrary.make(BinarySchema)

describe('Binary model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(binaryArb, (binary) => {
        const encoded = Schema.encodeSync(BinarySchema)(binary)
        const decoded = Schema.decodeSync(BinarySchema)(encoded)
        expect(decoded).toSchemaEqual(BinarySchema, binary)
      })
    )
  })

  test('Binary.resourceType is "Binary"', () => {
    expect(Binary.resourceType).toBe('Binary')
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
      )
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
