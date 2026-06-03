import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from './code.ts'
import * as Coding from './coding.ts'

const codingArb = Arbitrary.make(Coding.Schema)

describe('Coding model', () => {
  test('Coding.ResourceType is "Coding"', () => {
    expect(Coding.ResourceType).toBe('Coding')
  })

  test('property: encode-decode cycle', () => {
    fc.assert(
      fc.property(codingArb, (coding) => {
        const encoded = Schema.encodeSync(Coding.Schema)(coding)
        const decoded = Schema.decodeSync(Coding.Schema)(encoded)
        expect(decoded).toSchemaEqual(Coding.Schema, coding)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// `makeLiteral` constructs via `CodingSchema.make(params, { disableValidation:
// true })`. These tests answer the reviewer's soundness question: because the
// `make` input is the *decoded Type* side of the struct, the brand on `code`
// (`Code`) and the `URL` Type of `system` are enforced at compile time. The
// validation bypass therefore only skips a runtime walk that, for this schema,
// has no invariant the static type doesn't already guarantee — so it is a pure
// performance optimisation, not a soundness hole, for any type-checked call.
type CodingMakeInput = Parameters<typeof Coding.Schema.make>[0]

describe('Coding.makeLiteral', () => {
  const sample = (): typeof Coding.Schema.Type =>
    Coding.makeLiteral({
      id: null,
      extension: [],
      code: Code.make('1234-5'),
      display: 'Sample',
      system: new URL('http://loinc.org/'),
      userSelected: null,
      version: null,
    })

  test('re-validates against the schema — disableValidation adds no invalid state for well-typed input', () => {
    // The whole premise of skipping validation is that the type system has
    // already proved the shape. Assert the constructed value would still pass
    // a full validation walk: the bypass is a perf win, not a correctness gap.
    expect(() => Schema.validateSync(Coding.Schema)(sample())).not.toThrow()
  })

  test('encodes the branded code and URL system to their wire forms', () => {
    const encoded = Schema.encodeSync(Coding.Schema)(sample())
    expect(encoded.code).toBe('1234-5')
    expect(encoded.system).toBe('http://loinc.org/')
    expect(encoded.display).toBe('Sample')
  })

  test('round-trips through encode → decode', () => {
    const coding = sample()
    const decoded = Schema.decodeSync(Coding.Schema)(Schema.encodeSync(Coding.Schema)(coding))
    expect(decoded).toSchemaEqual(Coding.Schema, coding)
  })

  test('preserves the exact literal values it was constructed from', () => {
    const coding = Coding.makeLiteral({
      id: null,
      extension: [],
      code: Code.make('final'),
      display: 'Final',
      system: null,
      userSelected: true,
      version: '1.0.0',
    })
    expect(coding.display).toBe('Final')
    expect(coding.userSelected).toBe(true)
    expect(coding.version).toBe('1.0.0')
  })

  describe('type boundary — make input is the decoded Type side', () => {
    test('accepts a branded code and a URL system', () => {
      const code: CodingMakeInput['code'] = Code.make('ok')
      const system: CodingMakeInput['system'] = new URL('http://example.test/')
      expect(code).toBe('ok')
      expect(system.href).toBe('http://example.test/')
    })

    test('rejects a raw string for the branded `code` field', () => {
      // @ts-expect-error a plain string lacks the `code` brand; the brand is
      // enforced at compile time even though runtime validation is disabled.
      const code: CodingMakeInput['code'] = 'raw-string'
      expect(code).toBe('raw-string')
    })

    test('rejects a raw string for the URL `system` field', () => {
      // @ts-expect-error `system` is `Schema.URL`, whose Type side is a `URL`
      // instance — a string is not assignable.
      const system: CodingMakeInput['system'] = 'http://loinc.org/'
      expect(system).toBe('http://loinc.org/')
    })

    test('rejects a number for the string `display` field', () => {
      // @ts-expect-error `display` is `string | null`; a number is rejected.
      const display: CodingMakeInput['display'] = 123
      expect(display).toBe(123)
    })
  })
})
