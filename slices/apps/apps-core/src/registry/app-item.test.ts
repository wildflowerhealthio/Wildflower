import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { AppIdSchema, AppKindSchema, CustomAppSchema, makeAppId } from './app-item.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppIdSchema', () => {
  it('brands any non-empty string', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expectRightToEqual(Schema.decodeUnknownEither(AppIdSchema)(value), makeAppId(value))
      })
    )
  })

  it('rejects non-string inputs', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppIdSchema)(42),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('AppKindSchema', () => {
  it.each(['bundled', 'custom', 'action'] as const)('accepts %s', (kind) => {
    expectRightToEqual(Schema.decodeUnknownEither(AppKindSchema)(kind), kind)
  })

  it('rejects unknown kinds', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppKindSchema)('mystery'),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CustomAppSchema', () => {
  it('round-trips any schema-conformant value', () => {
    fc.assert(
      fc.property(Arbitrary.make(CustomAppSchema), (custom) => {
        const encoded = Schema.encodeSync(CustomAppSchema)(custom)
        expect(Schema.decodeSync(CustomAppSchema)(encoded)).toEqual(custom)
      })
    )
  })

  it('rejects payloads missing url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CustomAppSchema)({
        id: 'x',
        name: 'X',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
