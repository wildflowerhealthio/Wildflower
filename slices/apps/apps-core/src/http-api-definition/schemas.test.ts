import { Schema } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppEntrySchema,
  AppNotFoundSchema,
  CreateCustomAppBodySchema,
  InvalidFieldSchema,
  UpdateAppBodySchema,
} from './schemas.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppEntrySchema', () => {
  it('accepts an entry with a subtitle', () => {
    const entry = {
      id: 'patient-browser',
      name: 'Patient Browser',
      subtitle: 'Browse records',
      url: '{origin}/installed-apps/patient-browser/index.html',
      requiresTunnel: false,
      enabled: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppEntrySchema)(entry), entry)
  })

  it('accepts an entry without a subtitle', () => {
    const entry = {
      id: 'custom-1',
      name: 'My Custom',
      url: 'https://example.com',
      requiresTunnel: false,
      enabled: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppEntrySchema)(entry), entry)
  })

  it('rejects an empty-string subtitle', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppEntrySchema)({
        id: 'x',
        name: 'X',
        subtitle: '',
        url: 'https://example.com',
        requiresTunnel: false,
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects entries missing url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppEntrySchema)({
        id: 'x',
        name: 'X',
        requiresTunnel: false,
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CreateCustomAppBodySchema', () => {
  it('accepts a well-formed body', () => {
    const body = {
      name: 'My App',
      url: 'https://example.com',
      requiresTunnel: false,
    }
    expectRightToEqual(Schema.decodeUnknownEither(CreateCustomAppBodySchema)(body), body)
  })

  it('rejects an empty name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateCustomAppBodySchema)({
        name: '',
        url: 'https://example.com',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
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

  it('rejects a malformed url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateCustomAppBodySchema)({
        name: 'X',
        url: 'javascript:alert(1)',
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

  it('rejects empty-string name on partial update', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(UpdateAppBodySchema)({ name: '' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects malformed url on partial update', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(UpdateAppBodySchema)({ url: 'data:text/html,<script>' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
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

describe('InvalidFieldSchema', () => {
  it('accepts the InvalidUrl and InvalidName discriminants', () => {
    for (const error of ['InvalidUrl', 'InvalidName'] as const) {
      expectRightToEqual(
        Schema.decodeUnknownEither(InvalidFieldSchema)({ error, message: 'nope' }),
        { error, message: 'nope' }
      )
    }
  })

  it('rejects any other error literal', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InvalidFieldSchema)({ error: 'Whatever', message: 'x' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
