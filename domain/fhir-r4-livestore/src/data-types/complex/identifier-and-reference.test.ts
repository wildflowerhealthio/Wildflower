import { Arbitrary, Effect, Exit, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import { ExternalAssertionError } from 'ontology/errors'

import { Identifier, Reference } from './identifier-and-reference.ts'
import type { IdentifierEncoded, ReferenceEncoded } from './identifier-and-reference.ts'

const referenceArb = Arbitrary.make(Reference)

describe('Reference model', () => {
  test('Reference.ResourceType is "Reference"', () => {
    expect(Reference.ResourceType).toBe('Reference')
  })

  test('should encode to encoded type', () => {
    expectTypeOf<typeof Reference.Encoded>().toExtend<ReferenceEncoded>()
  })
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const encoded = Schema.encodeSync(Reference)(reference)
        const decoded = Schema.decodeSync(Reference)(encoded)
        expect(decoded).toSchemaEqual(reference)
      })
    )
  })

  describe('asResourceUrl', () => {
    test('succeeds when type matches and reference is a valid URL', () => {
      const ref = new Reference({
        reference: 'https://example.com/TestResource/123',
        type: 'TestResource',
      })
      const result = Effect.runSyncExit(ref.asResourceUrl())
      expect(Exit.isSuccess(result)).toBe(true)
    })

    test('fails with ExternalAssertionError when reference is undefined', () => {
      const ref = new Reference({
        reference: undefined,
      })
      const result = Effect.runSyncExit(ref.asResourceUrl())
      expect(Exit.isFailure(result)).toBe(true)
    })

    test('fails with ExternalAssertionError when reference is absent but type is present', () => {
      const ref = new Reference({
        type: 'TestResource',
      })
      const result = Effect.runSyncExit(ref.asResourceUrl())
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = result.cause.pipe((c) => {
          if (c._tag === 'Fail') {
            return c.error
          }
          return undefined
        })
        expect(error).toBeInstanceOf(ExternalAssertionError)
      }
    })
  })

  describe('fromResource', () => {
    test('returns a Reference when url is present', () => {
      const url = 'https://example.com/TestResource/456'
      const result = Reference.fromResource({
        resourceType: 'TestResource',
        meta: { source: url },
      })
      expect(result).toBeInstanceOf(Reference)
      expect(result?.type).toBe('TestResource')
      expect(result?.reference).toBe('https://example.com/TestResource/456')
    })

    test('returns a Reference with display when provided', () => {
      const url = 'https://example.com/TestResource/456'
      const result = Reference.fromResource(
        { resourceType: 'TestResource', meta: { source: url } },
        'Test Display'
      )
      expect(result).toBeInstanceOf(Reference)
      expect(result?.display).toBe('Test Display')
    })

    test('returns undefined when meta.source is undefined', () => {
      const result = Reference.fromResource({
        resourceType: 'TestResource',
        meta: { source: undefined },
      })
      expect(result).toBeUndefined()
    })
  })
})

const identifierArb = Arbitrary.make(Identifier)

describe('Identifier model', () => {
  test('Identifier.ResourceType is "Identifier"', () => {
    expect(Identifier.ResourceType).toBe('Identifier')
  })

  test('should encode to encoded type', () => {
    expectTypeOf<typeof Identifier.Encoded>().toExtend<IdentifierEncoded>()
  })
  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(identifierArb, (identifier) => {
        const encoded = Schema.encodeSync(Identifier)(identifier)
        const decoded = Schema.decodeSync(Identifier)(encoded)
        expect(decoded).toSchemaEqual(identifier)
      })
    )
  })
})
