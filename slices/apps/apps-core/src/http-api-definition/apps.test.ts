import { Arbitrary, Schema } from 'effect'
import fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppEntrySchema,
  AppNotFoundSchema,
  BundledAppImmutableSchema,
  CreateCustomAppBodySchema,
  UpdateAppBodySchema,
} from './apps.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppEntrySchema', () => {
  it('round-trips any schema-conformant entry', () => {
    fc.assert(
      fc.property(Arbitrary.make(AppEntrySchema), (entry) => {
        const encoded = Schema.encodeSync(AppEntrySchema)(entry)
        expect(Schema.decodeSync(AppEntrySchema)(encoded)).toEqual(entry)
      })
    )
  })

  it('rejects entries missing kind', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppEntrySchema)({
        id: 'x',
        name: 'X',
        subtitle: '',
        requiresTunnel: false,
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CreateCustomAppBodySchema', () => {
  it('round-trips any schema-conformant body', () => {
    fc.assert(
      fc.property(Arbitrary.make(CreateCustomAppBodySchema), (body) => {
        const encoded = Schema.encodeSync(CreateCustomAppBodySchema)(body)
        expect(Schema.decodeSync(CreateCustomAppBodySchema)(encoded)).toEqual(body)
      })
    )
  })

  it('rejects bodies missing url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateCustomAppBodySchema)({
        name: 'X',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('UpdateAppBodySchema', () => {
  it('accepts an empty body (no fields)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(UpdateAppBodySchema)({}), {})
  })

  it('accepts partial field bodies', () => {
    expectRightToEqual(Schema.decodeUnknownEither(UpdateAppBodySchema)({ enabled: false }), {
      enabled: false,
    })
  })
})

describe('AppNotFoundSchema', () => {
  it('accepts the declared error payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(AppNotFoundSchema)({ error: 'AppNotFound', id: 'missing' }),
      { error: 'AppNotFound', id: 'missing' }
    )
  })

  it('rejects any other error literal', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppNotFoundSchema)({ error: 'Whatever', id: 'x' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('BundledAppImmutableSchema', () => {
  it('accepts the declared error payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(BundledAppImmutableSchema)({
        error: 'BundledAppImmutable',
        id: 'patient-browser',
      }),
      { error: 'BundledAppImmutable', id: 'patient-browser' }
    )
  })
})
