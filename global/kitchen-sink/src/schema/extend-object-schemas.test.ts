import { Effect, Schema, pipe } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { extendObjectSchemas } from './extend-object-schemas.ts'

describe('extendObjectSchemas', () => {
  describe('two plain structs', () => {
    const ab = extendObjectSchemas(
      Schema.Struct({ name: Schema.String }),
      Schema.Struct({ age: Schema.Int })
    )

    it('decodes', () => {
      const result = Schema.decodeUnknownSync(ab)({ age: 30, name: 'Alice' })
      expect(result).toEqual({ age: 30, name: 'Alice' })
    })

    it('encodes', () => {
      const result = Schema.encodeUnknownSync(ab)({ age: 30, name: 'Alice' })
      expect(result).toEqual({ age: 30, name: 'Alice' })
    })
  })

  describe('transformOrFail + struct with fromKey', () => {
    // Simulates the ElementIdentification pattern: {id} → {url}
    const identification = Schema.transformOrFail(
      Schema.Struct({ id: Schema.optional(Schema.String) }),
      Schema.Struct({ url: Schema.optional(Schema.String) }),
      {
        decode: (input) =>
          Effect.succeed({
            // oxlint-disable-next-line eslint/no-ternary -- concise test fixture
            url: input.id ? `http://example.com/${input.id}` : undefined,
          }),
        encode: (input) => Effect.succeed({ id: input.url?.split('/').pop() }),
        strict: true,
      }
    )

    // Simulates the Extension pattern: FHIR 'url' → domain 'definitionUrl'
    const fieldsWithFromKey = Schema.Struct({
      definitionUrl: pipe(Schema.String, Schema.propertySignature, Schema.fromKey('url')),
      value: Schema.optional(Schema.String),
    })

    // This is the combination that Schema.extend cannot handle
    const combined = extendObjectSchemas(identification, fieldsWithFromKey)

    it('decodes, running both transforms', () => {
      const result = Schema.decodeUnknownSync(combined)({
        id: '123',
        url: 'http://hl7.org/fhir/extension',
        value: 'hello',
      })
      expect(result).toEqual({
        definitionUrl: 'http://hl7.org/fhir/extension',
        url: 'http://example.com/123',
        value: 'hello',
      })
    })

    it('encodes, reversing both transforms', () => {
      const result = Schema.encodeUnknownSync(combined)({
        definitionUrl: 'http://hl7.org/fhir/extension',
        url: 'http://example.com/123',
        value: 'hello',
      })
      expect(result).toEqual({
        id: '123',
        url: 'http://hl7.org/fhir/extension',
        value: 'hello',
      })
    })

    it('round-trips', () => {
      const input = {
        id: '456',
        url: 'http://hl7.org/fhir/some-ext',
        value: 'world',
      }
      const decoded = Schema.decodeUnknownSync(combined)(input)
      const reEncoded = Schema.encodeUnknownSync(combined)(decoded)
      expect(reEncoded).toEqual(input)
    })
  })

  describe('type-level key collision detection', () => {
    it('prevents type-level key overlap (also throws at runtime)', () => {
      const a = Schema.Struct({ name: Schema.String })
      const b = Schema.Struct({ name: Schema.Int })
      expect(() => extendObjectSchemas(a, b)).toThrow(/overlapping/)
    })

    it('prevents encoded-level key overlap', () => {
      const a = Schema.Struct({ name: Schema.String })
      const b = Schema.Struct({
        label: pipe(Schema.String, Schema.propertySignature, Schema.fromKey('name')),
      })
      // Schema.extend merges compatible encoded types at runtime without error,
      // But extendObjectSchemas catches the collision at the type level
      const result = extendObjectSchemas(a, b)
      expectTypeOf(result).toBeString()
    })
  })
})
