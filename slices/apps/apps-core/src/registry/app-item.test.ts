import { Schema } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { AppKindSchema, CustomAppSchema, CustomAppUrlSchema } from './app-item.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

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

describe('CustomAppUrlSchema', () => {
  it.each([
    'https://example.com',
    'https://example.com/launch?launch=x',
    '/apps/local',
    '/fhir-r4/Patient/123',
    '{origin}/some/path',
    '{origin}/{launch}',
  ])('accepts %s', (url) => {
    expectRightToEqual(Schema.decodeUnknownEither(CustomAppUrlSchema)(url), url)
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
      Schema.decodeUnknownEither(CustomAppUrlSchema)(url),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CustomAppSchema', () => {
  it('accepts a well-formed value', () => {
    const value = {
      id: 'custom-1',
      name: 'My App',
      url: 'https://example.com',
      requiresTunnel: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(CustomAppSchema)(value), value)
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

  it('rejects an empty name', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CustomAppSchema)({
        id: 'x',
        name: '',
        url: 'https://example.com',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a malformed url', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CustomAppSchema)({
        id: 'x',
        name: 'X',
        url: 'javascript:alert(1)',
        requiresTunnel: false,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
