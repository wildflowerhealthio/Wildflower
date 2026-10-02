import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  AppBodySchema,
  AppNotFoundSchema,
  AppRegistrationSchema,
  AppUrlSchema,
  HomeScreenSchema,
  InsufficientScopeSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
} from './schemas.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('AppBodySchema', () => {
  it('accepts a well-formed body', () => {
    const body = { name: 'My App', url: 'https://example.com/launch', requiresTunnel: false }
    expectRightToEqual(Schema.decodeUnknownEither(AppBodySchema)(body), body)
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
    expectRightToEqual(Schema.decodeUnknownEither(AppBodySchema)(body), body)
  })

  it('rejects an empty name, a bad url, or a missing url', () => {
    for (const bad of [
      { name: '', url: 'https://example.com', requiresTunnel: false },
      { name: 'X', url: 'javascript:alert(1)', requiresTunnel: false },
      { name: 'X', requiresTunnel: false },
    ]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(AppBodySchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  })
})

describe('AppUrlSchema', () => {
  it.each([
    'https://example.com',
    'https://example.com/launch?launch={launch}&iss={origin}/fhir-r4',
    'http://localhost:5193/launch.html',
  ])('accepts %s', (url) => {
    expectRightToEqual(Schema.decodeUnknownEither(AppUrlSchema)(url), url)
  })

  it.each([
    '',
    '/apps/local',
    '{origin}/some/path',
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

describe('AppRegistrationSchema', () => {
  const withOptionalSubtitle = <T extends object>(base: T): fc.Arbitrary<T> =>
    fc
      .option(fc.string({ minLength: 1 }), { nil: undefined })
      .map((subtitle) => (subtitle === undefined ? base : { ...base, subtitle }))

  const registrationArb = fc
    .record({
      id: fc.string({ minLength: 1 }),
      onHomescreen: fc.boolean(),
      name: fc.string({ minLength: 1 }),
      url: fc.string({ minLength: 1 }),
      isSmart: fc.boolean(),
      requiresTunnel: fc.boolean(),
    })
    .chain(withOptionalSubtitle)

  it('decodes any well-formed registration to itself', () => {
    fc.assert(
      fc.property(registrationArb, (entry) => {
        expectRightToEqual(Schema.decodeUnknownEither(AppRegistrationSchema)(entry), entry)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects an empty-string subtitle and a missing field', () => {
    const base = {
      id: 'x',
      onHomescreen: true,
      name: 'X',
      url: 'https://example.com/launch?iss={origin}',
      isSmart: true,
      requiresTunnel: true,
    }
    const { onHomescreen: _onHomescreen, ...withoutOnHomescreen } = base
    const { url: _url, ...withoutUrl } = base
    for (const bad of [{ ...base, subtitle: '' }, withoutOnHomescreen, withoutUrl]) {
      expectLeftToEqual(
        Schema.decodeUnknownEither(AppRegistrationSchema)(bad),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
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

describe('HomeScreenSchema', () => {
  it('decodes an ordered list of { id, onHomescreen } entries', () => {
    const body = [
      { id: 'medications-app', onHomescreen: true },
      { id: 'growth-chart', onHomescreen: false },
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
