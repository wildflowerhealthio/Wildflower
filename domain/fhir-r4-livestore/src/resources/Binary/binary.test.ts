import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import type { DeepReadonly } from 'kitchen-sink/types'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { Code } from '../../data-types/index.ts'
import type { BinaryEncoded } from './binary.ts'
import * as Binary from './binary.ts'

const binaryArb = Arbitrary.make(Binary.Binary)

describe('Binary model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(binaryArb, (binary) => {
        const encoded = Schema.encodeSync(Binary.Binary)(binary)
        const decoded = Schema.decodeSync(Binary.Binary)(encoded)
        expect(decoded).toSchemaEqual(binary)
      })
    )
  })

  test('Binary.ResourceType is "Binary"', () => {
    expect(Binary.Binary.ResourceType).toBe('Binary')
  })

  test('Binary.IdSchema is defined', () => {
    expect(Binary.Binary.IdSchema).toBeDefined()
  })

  test('Binary.make allows for absent fields', () => {
    expect(
      Binary.Binary.make({
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
          const decode = Schema.decodeUnknownEither(Binary.Binary)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      )
    )
  })

  test('fhir4.Binary is assignable to BinaryEncoded', () => {
    expectTypeOf<DeepReadonly<fhir4.Binary>>().toExtend<BinaryEncoded>()
  })
})
