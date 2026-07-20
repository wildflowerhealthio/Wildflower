import { Schema } from 'effect'
import * as fc from 'fast-check'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppRegistrationSchema,
  AppUrlSchema,
  CloudAppBodySchema,
  CloudAppDetailSchema,
  HomeScreenSchema,
  InsufficientScopeSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  KindSchema,
  SelfHostedAppBodySchema,
  SelfHostedAppDetailSchema,
  SystemAppDetailSchema,
} from './schemas.ts'

const KINDS = ['system', 'self-hosted', 'cloud'] as const

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('CloudAppBodySchema', () => {
  it('accepts a well-formed cloud body', () => {
    const body = { name: 'My App', url: 'https://example.com/launch', requiresTunnel: false }
    expectRightToEqual(Schema.decodeUnknownEither(CloudAppBodySchema)(body), body)
  })

  // The write side accepts `""` (which the read schema rejects); the server
  // normalizes it to "no subtitle" so it never round-trips back as `""`.
  it('accepts an empty-string subtitle (server clears it)', () => {
    const body = {
      name: 'X',
      url: 'https://example.com',
      requiresTunnel: false,
      subtitle: '',
    }
    expectRightToEqual(Schema.decodeUnknownEither(CloudAppBodySchema)(body), body)
  })

  it('rejects an empty name, a bad url, or a missing url', () => {
    for (const bad of [
      { name: '', url: 'https://example.com', requiresTunnel: false },
      { name: 'X', url: 'javascript:alert(1)', requiresTunnel: false },
      { name: 'X', requiresTunnel: false },
    ]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(CloudAppBodySchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  })
})

describe('SelfHostedAppBodySchema', () => {
  it('accepts a bare body, a launch path, and an empty (cleared) launch path', () => {
    for (const body of [
      {},
      { launchPath: '/launch.html?iss={origin}/fhir-r4' },
      { launchPath: '' },
    ]) {
      expectRightToEqual(Schema.decodeUnknownEither(SelfHostedAppBodySchema)(body), body)
    }
  })

  it('rejects a non-origin-relative launch path', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(SelfHostedAppBodySchema)({
        launchPath: 'https://evil.example/launch',
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

describe('KindSchema', () => {
  it('accepts the three kebab values', () => {
    for (const k of KINDS) {
      expectRightToEqual(Schema.decodeUnknownEither(KindSchema)(k), k)
    }
  })

  it('rejects any non-kind string', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(KINDS as readonly string[]).includes(s)),
        (s) => {
          expect(Schema.decodeUnknownEither(KindSchema)(s)._tag).toBe('Left')
        }
      )
    )
  })
})

describe('AppRegistrationSchema', () => {
  const withOptionalSubtitle = <T extends object>(base: T): fc.Arbitrary<T> =>
    fc
      .option(fc.string({ minLength: 1 }), { nil: undefined })
      .map((subtitle) => (subtitle === undefined ? base : { ...base, subtitle }))

  const registrationArb = fc
    .record({
      id: fc.string({ minLength: 1 }),
      kind: fc.constantFrom(...KINDS),
      onHomescreen: fc.boolean(),
      name: fc.string({ minLength: 1 }),
      localOnly: fc.boolean(),
      isSmart: fc.boolean(),
      requiresTunnel: fc.boolean(),
    })
    .chain(withOptionalSubtitle)

  it('decodes any well-formed uniform registration to itself', () => {
    fc.assert(
      fc.property(registrationArb, (entry) => {
        expectRightToEqual(Schema.decodeUnknownEither(AppRegistrationSchema)(entry), entry)
      })
    )
  })

  it('rejects an empty-string subtitle, a bad kind, and a missing shared field', () => {
    const base = {
      id: 'x',
      kind: 'cloud',
      onHomescreen: true,
      name: 'X',
      localOnly: false,
      isSmart: true,
      requiresTunnel: true,
    }
    for (const bad of [
      { ...base, subtitle: '' },
      { ...base, kind: 'external' },
      { id: 'x', kind: 'cloud', name: 'X', localOnly: false, isSmart: true, requiresTunnel: true },
    ]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(AppRegistrationSchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  })
})

describe('per-kind detail schemas', () => {
  const registration = {
    id: 'x',
    kind: 'cloud',
    onHomescreen: true,
    name: 'X',
    localOnly: false,
    isSmart: true,
    requiresTunnel: true,
  }

  it('CloudAppDetailSchema carries the url template + isRemovable', () => {
    const detail = {
      ...registration,
      url: 'https://example.com/launch?iss={origin}',
      isRemovable: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(CloudAppDetailSchema)(detail), detail)
  })

  it('CloudAppDetailSchema rejects a body missing url or isRemovable', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CloudAppDetailSchema)({ ...registration, isRemovable: true }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('SelfHostedAppDetailSchema carries launchPath?, seeded, and isRemovable', () => {
    const seeded = {
      ...registration,
      kind: 'self-hosted',
      seeded: true,
      isRemovable: false,
    }
    expectRightToEqual(Schema.decodeUnknownEither(SelfHostedAppDetailSchema)(seeded), seeded)
    const withPath = {
      ...registration,
      kind: 'self-hosted',
      launchPath: '/launch.html',
      seeded: false,
      isRemovable: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(SelfHostedAppDetailSchema)(withPath), withPath)
  })

  it('SystemAppDetailSchema carries the url but no isRemovable', () => {
    const detail = { ...registration, kind: 'system', url: '{origin}/docs' }
    expectRightToEqual(Schema.decodeUnknownEither(SystemAppDetailSchema)(detail), detail)
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

describe('HomeScreenSchema', () => {
  it('decodes an ordered list of { id, onHomescreen } entries', () => {
    const body = [
      { id: 'patient-browser', onHomescreen: true },
      { id: 'api-view', onHomescreen: false },
    ]
    expectRightToEqual(Schema.decodeUnknownEither(HomeScreenSchema)(body), body)
  })

  it('accepts an empty array', () => {
    expectRightToEqual(Schema.decodeUnknownEither(HomeScreenSchema)([]), [])
  })

  it('rejects an entry missing onHomescreen or with a non-boolean onHomescreen', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(HomeScreenSchema)([{ id: 'x' }]),
      expect.objectContaining({ _tag: 'ParseError' })
    )
    expectLeftToEqual(
      Schema.decodeUnknownEither(HomeScreenSchema)([{ id: 'x', onHomescreen: 'yes' }]),
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

describe('InsufficientScopeSchema', () => {
  it('accepts the declared 403 payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(InsufficientScopeSchema)({
        error: 'InsufficientScope',
        missingScopes: ['wildflower/Apps.c'],
      }),
      { error: 'InsufficientScope', missingScopes: ['wildflower/Apps.c'] }
    )
  })

  it('rejects any other error literal', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InsufficientScopeSchema)({
        error: 'AppNotFound',
        missingScopes: [],
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
