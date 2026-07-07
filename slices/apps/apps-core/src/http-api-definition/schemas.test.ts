import { Schema } from 'effect'
import * as fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppEntrySchema,
  AppListEntrySchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppUrlSchema,
  CreateAppBodySchema,
  CreateSelfHostedAppUrlParamsSchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  ProvenanceSchema,
  UpdateAppBodySchema,
  ZipPayloadSchema,
} from './schemas.ts'

const PROVENANCES = ['system', 'self-hosted', 'cloud'] as const

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppEntrySchema', () => {
  it('accepts an entry with a subtitle', () => {
    const entry = {
      id: 'patient-browser',
      name: 'Patient Browser',
      subtitle: 'Browse records',
      url: '{origin}/self-hosted-apps/patient-browser/index.html',
      requiresTunnel: false,
      enabled: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppEntrySchema)(entry), entry)
  })

  it('accepts an entry without a subtitle', () => {
    const entry = {
      id: 'app-1',
      name: 'My App',
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

describe('AppUrlSchema', () => {
  it.each([
    'https://example.com',
    'https://example.com/launch?launch=x',
    '/apps/local',
    '/fhir-r4/Patient/123',
    '{origin}/some/path',
    '{origin}/{launch}',
  ])('accepts %s', (url) => {
    expectRightToEqual(Schema.decodeUnknownEither(AppUrlSchema)(url), url)
  })

  it.each([
    '',
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'file:///etc/passwd',
    '//attacker.example',
    'ftp://example.com',
  ])('rejects %s', (url) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppUrlSchema)(url),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CreateAppBodySchema', () => {
  it('accepts a well-formed body', () => {
    const body = {
      name: 'My App',
      url: 'https://example.com',
      requiresTunnel: false,
    }
    expectRightToEqual(Schema.decodeUnknownEither(CreateAppBodySchema)(body), body)
  })

  it('rejects an empty name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateAppBodySchema)({
        name: '',
        url: 'https://example.com',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects bodies missing url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateAppBodySchema)({
        name: 'X',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a malformed url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateAppBodySchema)({
        name: 'X',
        url: 'javascript:alert(1)',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  // The write side accepts `""` (which the read schema rejects); the server
  // normalizes it to "no subtitle" so it never round-trips back as `""`.
  it('accepts an empty-string subtitle (server clears it)', () => {
    const body = { name: 'X', url: 'https://example.com', requiresTunnel: false, subtitle: '' }
    expectRightToEqual(Schema.decodeUnknownEither(CreateAppBodySchema)(body), body)
  })
})

describe('UpdateAppBodySchema', () => {
  it('accepts an empty body (no fields)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(UpdateAppBodySchema)({}), {})
  })

  it('accepts partial field bodies', () => {
    expectRightToEqual(Schema.decodeUnknownEither(UpdateAppBodySchema)({ requiresTunnel: true }), {
      requiresTunnel: true,
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

  // Same empty-string-clears-it contract as on create (above).
  it('accepts an empty-string subtitle (clears it server-side)', () => {
    expectRightToEqual(Schema.decodeUnknownEither(UpdateAppBodySchema)({ subtitle: '' }), {
      subtitle: '',
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

describe('InvalidFieldSchema', () => {
  it('accepts the InvalidUrl, InvalidName, and InvalidZip discriminants', () => {
    for (const error of ['InvalidUrl', 'InvalidName', 'InvalidZip'] as const) {
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

describe('ProvenanceSchema', () => {
  it('accepts the three kebab values', () => {
    for (const p of PROVENANCES) {
      expectRightToEqual(Schema.decodeUnknownEither(ProvenanceSchema)(p), p)
    }
  })

  it('rejects any non-provenance string', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(PROVENANCES as readonly string[]).includes(s)),
        (s) => {
          expect(Schema.decodeUnknownEither(ProvenanceSchema)(s)._tag).toBe('Left')
        }
      )
    )
  })
})

describe('AppListEntrySchema', () => {
  // A well-formed `GET /apps` row: required flags + an optional non-empty
  // subtitle. The launch `url` is never present on this shape.
  const appListEntryArb = fc
    .record({
      id: fc.string({ minLength: 1 }),
      name: fc.string({ minLength: 1 }),
      provenance: fc.constantFrom(...PROVENANCES),
      localOnly: fc.boolean(),
      smart: fc.boolean(),
      requiresTunnel: fc.boolean(),
      enabled: fc.boolean(),
      removable: fc.boolean(),
    })
    .chain((base) =>
      fc
        .option(fc.string({ minLength: 1 }), { nil: undefined })
        .map((subtitle) => (subtitle === undefined ? base : { ...base, subtitle }))
    )

  it('decodes any well-formed row to itself', () => {
    fc.assert(
      fc.property(appListEntryArb, (entry) => {
        expectRightToEqual(Schema.decodeUnknownEither(AppListEntrySchema)(entry), entry)
      })
    )
  })

  it('rejects an empty-string subtitle and a bad provenance', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppListEntrySchema)({
        id: 'x',
        name: 'X',
        subtitle: '',
        provenance: 'cloud',
        localOnly: false,
        smart: true,
        requiresTunnel: true,
        enabled: true,
        removable: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppListEntrySchema)({
        id: 'x',
        name: 'X',
        provenance: 'external',
        localOnly: false,
        smart: false,
        requiresTunnel: false,
        enabled: true,
        removable: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a row missing the required removable flag', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppListEntrySchema)({
        id: 'x',
        name: 'X',
        provenance: 'cloud',
        localOnly: false,
        smart: false,
        requiresTunnel: false,
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CreateSelfHostedAppUrlParamsSchema', () => {
  it('accepts a non-empty name', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(CreateSelfHostedAppUrlParamsSchema)({ name: 'Patient Browser' }),
      { name: 'Patient Browser' }
    )
  })

  it('rejects an empty name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateSelfHostedAppUrlParamsSchema)({ name: '' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a body missing name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CreateSelfHostedAppUrlParamsSchema)({}),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('ZipPayloadSchema', () => {
  it('decodes a Uint8Array of zip bytes to itself', () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        expectRightToEqual(Schema.decodeUnknownEither(ZipPayloadSchema)(bytes), bytes)
      })
    )
  })

  it('rejects a non-Uint8Array payload', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ZipPayloadSchema)([1, 2, 3]),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('HomeScreenSchema', () => {
  it('decodes an ordered list of { id, enabled } entries', () => {
    const body = [
      { id: 'patient-browser', enabled: true },
      { id: 'api-view', enabled: false },
    ]
    expectRightToEqual(Schema.decodeUnknownEither(HomeScreenSchema)(body), body)
  })

  it('accepts an empty array', () => {
    expectRightToEqual(Schema.decodeUnknownEither(HomeScreenSchema)([]), [])
  })

  it('rejects an entry missing enabled or with a non-boolean enabled', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(HomeScreenSchema)([{ id: 'x' }]),
      expect.objectContaining({ _tag: 'ParseError' })
    )
    expectLeftToEqual(
      Schema.decodeUnknownEither(HomeScreenSchema)([{ id: 'x', enabled: 'yes' }]),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('InvalidHomeScreenSchema', () => {
  it('accepts the declared 400 payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(InvalidHomeScreenSchema)({
        error: 'InvalidHomeScreen',
        message: 'must list every app exactly once',
      }),
      { error: 'InvalidHomeScreen', message: 'must list every app exactly once' }
    )
  })

  it('rejects any other error literal', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InvalidHomeScreenSchema)({ error: 'AppNotFound', message: 'x' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('AppNotEditableSchema', () => {
  it('accepts the declared 409 payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(AppNotEditableSchema)({ error: 'AppNotEditable', id: 'api-docs' }),
      { error: 'AppNotEditable', id: 'api-docs' }
    )
  })

  it('rejects any other error literal', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppNotEditableSchema)({ error: 'AppNotFound', id: 'x' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
