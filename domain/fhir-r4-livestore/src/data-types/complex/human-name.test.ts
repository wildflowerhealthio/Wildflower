import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as HumanName from './human-name.ts'

const humanNameArb = Arbitrary.make(HumanName.HumanName)
const decode = Schema.decodeUnknownEither(HumanName.HumanName)

describe('HumanName model', () => {
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(humanNameArb, (humanName) => {
        const encoded = Schema.encodeSync(HumanName.HumanName)(humanName)
        const decoded = Schema.decodeSync(HumanName.HumanName)(encoded)
        expect(decoded).toSchemaEqual(humanName)
      })
    )
  })

  describe('family field', () => {
    test('decodes a plain string', () => {
      const result = decode({ family: 'Smith' })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBe('Smith')
      }
    })

    test('decodes undefined as undefined', () => {
      const result = decode({})
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBeUndefined()
      }
    })

    test('decodes a singleton array to the element', () => {
      const result = decode({ family: ['Smith'] })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBe('Smith')
      }
    })

    test('decodes an empty array to undefined', () => {
      const result = decode({ family: [] })
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.family).toBeUndefined()
      }
    })

    test('rejects a multi-element array', () => {
      const result = decode({ family: ['Smith', 'Jones'] })
      expect(Either.isLeft(result)).toBe(true)
    })

    test('property: singleton array round-trips through the string branch', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (name) => {
          const result = decode({ family: [name] })
          expect(Either.isRight(result)).toBe(true)
          if (Either.isRight(result)) {
            expect(result.right.family).toBe(name)
            const encoded = Schema.encodeSync(HumanName.HumanName)(result.right)
            expect(encoded.family).toBe(name)
          }
        })
      )
    })
  })
})
