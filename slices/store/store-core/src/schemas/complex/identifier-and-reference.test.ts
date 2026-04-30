import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Identifier from './identifier.ts'
import * as Reference from './reference.ts'

const referenceArb = Arbitrary.make(Reference.Schema)

describe('Reference model', () => {
  test('Reference.ResourceType is "Reference"', () => {
    expect(Reference.ResourceType).toBe('Reference')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(referenceArb, (reference) => {
        const encoded = Schema.encodeSync(Reference.Schema)(reference)
        const decoded = Schema.decodeSync(Reference.Schema)(encoded)
        expect(decoded).toSchemaEqual(Reference.Schema, reference)
      })
    )
  })

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

const identifierArb = Arbitrary.make(Identifier.Schema)

describe('Identifier model', () => {
  test('Identifier.ResourceType is "Identifier"', () => {
    expect(Identifier.ResourceType).toBe('Identifier')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(identifierArb, (identifier) => {
        const encoded = Schema.encodeSync(Identifier.Schema)(identifier)
        const decoded = Schema.decodeSync(Identifier.Schema)(encoded)
        expect(decoded).toSchemaEqual(Identifier.Schema, identifier)
      })
    )
  })
})
