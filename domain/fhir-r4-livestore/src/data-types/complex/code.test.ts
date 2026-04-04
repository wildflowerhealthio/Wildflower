import { Either, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from './code.ts'

describe('Code branded type', () => {
  test('decodes a valid string', () => {
    const result = Schema.decodeUnknownEither(Code)('active')
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toBe('active')
    }
  })

  test('rejects a non-string value', () => {
    const result = Schema.decodeUnknownEither(Code)(123)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('rejects null', () => {
    const result = Schema.decodeUnknownEither(Code)(null)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('rejects undefined', () => {
    const result = Schema.decodeUnknownEither(Code)(undefined)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('Code.make creates a branded code', () => {
    const code = Code.make('application/pdf')
    expect(code).toBe('application/pdf')
  })

  test('encode-decode round-trip preserves value', () => {
    const original = Code.make('some-code')
    const encoded = Schema.encodeSync(Code)(original)
    const decoded = Schema.decodeSync(Code)(encoded)
    expect(decoded).toBe(original)
  })
})
