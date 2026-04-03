import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import type { DeepReadonly } from 'kitchen-sink/types'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Code } from '../../data-types/index.ts'
import type { BinaryEncoded } from './binary.ts'
import { Binary } from './binary.ts'

const binaryArb = Arbitrary.make(Binary)

describe('Binary model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(binaryArb, (binary) => {
        const encoded = Schema.encodeSync(Binary)(binary)
        const decoded = Schema.decodeSync(Binary)(encoded)
        expect(decoded).toSchemaEqual(binary)
      })
    )
  })

  test('Binary.ResourceType is "Binary"', () => {
    expect(Binary.ResourceType).toBe('Binary')
  })

  test('Binary.IdSchema is defined', () => {
    expect(Binary.IdSchema).toBeDefined()
  })

  test('Binary.make allows for absent fields', () => {
    expect(
      Binary.make({
        contentType: Code.make('application/pdf'),
      })
    ).toBeDefined()
  })

  test('property: missing required fields always fail', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Wrong resourceType
          fc.record({
            resourceType: fc.constant('Patient' as const),
          }),
          // Missing contentType
          fc.record({
            resourceType: fc.constant('Binary' as const),
          })
        ),
        (incomplete) => {
          const decode = Schema.decodeUnknownEither(Binary)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      )
    )
  })

  test('BinaryWithId decodes successfully when id is present', () => {
    const payload = {
      resourceType: 'Binary',
      id: 'bin-001',
      contentType: 'application/pdf',
      data: 'SGVsbG8=',
    }
    const result = Schema.decodeUnknownEither(Binary.WithId)(payload)
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.id).toBe('bin-001')
      expect(result.right.contentType).toBe('application/pdf')
    }
  })

  test('BinaryWithId fails when id is missing', () => {
    const payload = {
      resourceType: 'Binary',
      contentType: 'application/pdf',
    }
    const result = Schema.decodeUnknownEither(Binary.WithId)(payload)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('fhir4.Binary is assignable to BinaryEncoded', () => {
    expectTypeOf<DeepReadonly<fhir4.Binary>>().toExtend<BinaryEncoded>()
  })
})
