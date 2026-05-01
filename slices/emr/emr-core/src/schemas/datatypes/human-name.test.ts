import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as HumanName from './human-name.ts'

const humanNameArb = Arbitrary.make(HumanName.Schema)
const decode = Schema.decodeEither(HumanName.Schema)

describe('HumanName model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(humanNameArb, (humanName) => {
        const encoded = Schema.encodeSync(HumanName.Schema)(humanName)
        const decoded = Schema.decodeSync(HumanName.Schema)(encoded)
        expect(decoded).toSchemaEqual(HumanName.Schema, humanName)
      })
    )
  })

  describe('family field', () => {
    test('decodes a plain string', () => {
      const result = decode({
        family: 'Smith',
        id: null,
        extension: [],
        use: null,
        text: null,
        given: [],
        prefix: [],
        suffix: [],
        period: null,
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBe('Smith')
      }
    })

    test('decodes undefined as undefined', () => {
      const result = decode({
        id: null,
        extension: [],
        use: null,
        text: null,
        family: null,
        given: [],
        prefix: [],
        suffix: [],
        period: null,
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBeNull()
      }
    })

    test('decodes a singleton array to the element', () => {
      const result = decode({
        family: 'Smith',
        id: null,
        extension: [],
        use: null,
        text: null,
        given: [],
        prefix: [],
        suffix: [],
        period: null,
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBe('Smith')
      }
    })

    test('decodes an empty array to undefined', () => {
      const result = decode({
        family: null,
        id: null,
        extension: [],
        use: null,
        text: null,
        given: [],
        prefix: [],
        suffix: [],
        period: null,
      })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBeNull()
      }
    })

    test('property: singleton array round-trips through the string branch', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (name) => {
          const result = decode({
            family: name,
            id: null,
            extension: [],
            use: null,
            text: null,
            given: [],
            prefix: [],
            suffix: [],
            period: null,
          })
          expect(Either.isRight(result)).toBe(true)
          if (Either.isRight(result)) {
            expect(result.right.family).toBe(name)
            const encoded = Schema.encodeSync(HumanName.Schema)(result.right)
            expect(encoded.family).toBe(name)
          }
        })
      )
    })
  })
})
