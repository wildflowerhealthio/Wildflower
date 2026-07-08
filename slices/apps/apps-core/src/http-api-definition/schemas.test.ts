import { Schema } from 'effect'
import * as fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppContentBodySchema,
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
  ZipPayloadSchema,
} from './schemas.ts'

const PROVENANCES = ['system', 'self-hosted', 'cloud'] as const

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppContentBodySchema', () => {
  it('accepts a cloud content body', () => {
    const body = {
      provenance: 'cloud',
      name: 'My App',
      url: 'https://example.com/launch',
      requiresTunnel: false,
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppContentBodySchema)(body), body)
  })

  it('accepts a self-hosted body with and without a launch path', () => {
    const bare = { provenance: 'self-hosted' }
    expectRightToEqual(Schema.decodeUnknownEither(AppContentBodySchema)(bare), bare)
    const withPath = { provenance: 'self-hosted', launchPath: '/launch.html?iss={origin}/fhir-r4' }
    expectRightToEqual(Schema.decodeUnknownEither(AppContentBodySchema)(withPath), withPath)
    // An empty launch path clears it back to root-serving.
    const cleared = { provenance: 'self-hosted', launchPath: '' }
    expectRightToEqual(Schema.decodeUnknownEither(AppContentBodySchema)(cleared), cleared)
  })

  it('rejects a self-hosted body with a non-origin-relative launch path', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppContentBodySchema)({
        provenance: 'self-hosted',
        launchPath: 'https://evil.example/launch',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a cloud body with an empty name or bad url', () => {
    for (const bad of [
      { provenance: 'cloud', name: '', url: 'https://example.com', requiresTunnel: false },
      { provenance: 'cloud', name: 'X', url: 'javascript:alert(1)', requiresTunnel: false },
      { provenance: 'cloud', name: 'X', requiresTunnel: false },
    ]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(AppContentBodySchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  })

  it('rejects a body with no (or an unknown) provenance arm', () => {
    for (const bad of [{ name: 'X' }, { provenance: 'system' }]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(AppContentBodySchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
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
  // The shared parent fields every variant carries.
  const sharedFields = {
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    enabled: fc.boolean(),
    localOnly: fc.boolean(),
    smart: fc.boolean(),
    removable: fc.boolean(),
  }
  const withOptionalSubtitle = <T extends object>(base: T): fc.Arbitrary<T> =>
    fc
      .option(fc.string({ minLength: 1 }), { nil: undefined })
      .map((subtitle) => (subtitle === undefined ? base : { ...base, subtitle }))
  // A valid member of each provenance variant, with its typed-child fields.
  const appListEntryArb = fc
    .oneof(
      fc.record({ ...sharedFields, provenance: fc.constant('system') }),
      fc.record({
        ...sharedFields,
        provenance: fc.constant('cloud'),
        url: fc.webUrl(),
        requiresTunnel: fc.boolean(),
      }),
      fc.record({ ...sharedFields, provenance: fc.constant('self-hosted') })
    )
    .chain(withOptionalSubtitle)

  it('decodes any well-formed variant to itself', () => {
    fc.assert(
      fc.property(appListEntryArb, (entry) => {
        expectRightToEqual(Schema.decodeUnknownEither(AppListEntrySchema)(entry), entry)
      })
    )
  })

  it('carries the cloud url template and self-hosted launch path on their variants', () => {
    const cloud = {
      id: 'c',
      name: 'C',
      enabled: true,
      localOnly: false,
      smart: true,
      removable: true,
      provenance: 'cloud',
      url: 'https://example.com/launch?iss={origin}/fhir-r4',
      requiresTunnel: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppListEntrySchema)(cloud), cloud)
    const selfHosted = {
      id: 's',
      name: 'S',
      enabled: true,
      localOnly: true,
      smart: false,
      removable: true,
      provenance: 'self-hosted',
      launchPath: '/launch.html?iss={origin}/fhir-r4',
    }
    expectRightToEqual(Schema.decodeUnknownEither(AppListEntrySchema)(selfHosted), selfHosted)
  })

  it('rejects an empty-string subtitle, a bad provenance, and a cloud row missing url/removable', () => {
    // Empty subtitle on an otherwise-valid cloud variant.
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppListEntrySchema)({
        id: 'x',
        name: 'X',
        subtitle: '',
        provenance: 'cloud',
        localOnly: false,
        smart: true,
        removable: true,
        url: 'https://example.com',
        requiresTunnel: true,
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
    // A provenance with no matching variant.
    expectLeftToEqual(
      Schema.decodeUnknownEither(AppListEntrySchema)({
        id: 'x',
        name: 'X',
        provenance: 'external',
        localOnly: false,
        smart: false,
        enabled: true,
        removable: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
    // A cloud row missing its `url` (variant-required) and `removable` (shared).
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
