import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import * as Bridge from './bridge.ts'
import * as UrlParamMessage from './url-param-message.ts'

const Hello = Schema.parseJson(Schema.TaggedStruct('Hello', { msg: Schema.String }))
const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.String }))
const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))

const TestBridge = Bridge.make({
  name: 'Test',
  hostToWeb: [
    ['Hello', Hello],
    ['Ping', Ping],
    ['Buzz', Buzz],
  ] as const,
  webToHost: [] as const,
  urlParams: {
    Hello: UrlParamMessage.singleStringMessageSchema('Hello', 'msg'),
    Ping: UrlParamMessage.singleStringMessageSchema('Ping', 'value'),
    Buzz: UrlParamMessage.tagOnlyMessageSchema('Buzz'),
  },
})
const bridges = [TestBridge] as const

const baseUrl = (): URL => new URL('https://app.local/')

describe('UrlParamMessage', () => {
  test('encodes a single-field message as ?<Tag>=<value>', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'world' },
    ])
    expect(url.searchParams.get('Hello')).toBe('world')
  })

  test('round-trips through encode → decode', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'world' },
    ])
    const wireStrings = UrlParamMessage.reEncodeMessagesFromParams(url.search, bridges)
    expect(wireStrings).toHaveLength(1)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({ _tag: 'Hello', msg: 'world' })
  })

  test('payload-less tag-only messages render as ?<Tag> without =', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Buzz' }])
    expect(url.search).toBe('?Buzz')
    const wireStrings = UrlParamMessage.reEncodeMessagesFromParams(url.search, bridges)
    expect(wireStrings).toHaveLength(1)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({ _tag: 'Buzz' })
  })

  test('uses the tag as the URL key (no msg. prefix)', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'hi' },
    ])
    expect([...url.searchParams.keys()]).toEqual(['Hello'])
  })

  test('returns [] for a search string with no bridge params', () => {
    expect(UrlParamMessage.reEncodeMessagesFromParams('?other=value&keep=this', bridges)).toEqual(
      []
    )
  })

  test('throws on encode of a tag without a urlParams schema', () => {
    const NoFlag = Schema.parseJson(Schema.TaggedStruct('NoFlag', {}))
    const NoUrlParamsBridge = Bridge.make({
      name: 'NoUrl',
      hostToWeb: [['NoFlag', NoFlag]] as const,
      webToHost: [] as const,
    })
    expect(() =>
      UrlParamMessage.appendMessagesToUrl(baseUrl(), [NoUrlParamsBridge], [{ _tag: 'NoFlag' }])
    ).toThrow(/no urlParams schema/)
  })

  test('round-trips UTF-8 strings (non-ASCII payloads)', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: '👋 héllo wörld 中文' },
    ])
    const wireStrings = UrlParamMessage.reEncodeMessagesFromParams(url.search, bridges)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({
      _tag: 'Hello',
      msg: '👋 héllo wörld 中文',
    })
  })

  test('multiple messages preserve order', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'first' },
      { _tag: 'Ping', value: 'second' },
      { _tag: 'Buzz' },
    ])
    const wireStrings = UrlParamMessage.reEncodeMessagesFromParams(url.search, bridges)
    expect(wireStrings.map((s) => JSON.parse(s))).toEqual([
      { _tag: 'Hello', msg: 'first' },
      { _tag: 'Ping', value: 'second' },
      { _tag: 'Buzz' },
    ])
  })

  test('URL value is single-encoded — no double-percent sequences', () => {
    // Regression: previously the per-field schema URL-encoded and then
    // `serializeParams` URL-encoded again, producing `%2520` for a space.
    // Round-trip masked this because both sides over-encoded symmetrically.
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'a b & c' },
    ])
    expect(url.search).toBe('?Hello=a%20b%20%26%20c')
    expect(url.search).not.toMatch(/%25[0-9A-F]{2}/)
    expect(url.searchParams.get('Hello')).toBe('a b & c')
  })

  test('existing URL params are preserved before appended bridge params', () => {
    // Regression: ordering was flipped during a refactor (new entries
    // first, existing last) — the comment said the opposite. Existing
    // params should come first so they survive in their original position.
    const seeded = new URL('https://app.local/?keep=before&also=here')
    const url = UrlParamMessage.appendMessagesToUrl(seeded, bridges, [
      { _tag: 'Hello', msg: 'after' },
    ])
    expect([...url.searchParams.keys()]).toEqual(['keep', 'also', 'Hello'])
  })

  test('property: arbitrary single-field messages round-trip', () => {
    const messageArb = fc.oneof(
      fc.string().map((msg) => ({ _tag: 'Hello' as const, msg })),
      fc.string().map((value) => ({ _tag: 'Ping' as const, value })),
      fc.constant({ _tag: 'Buzz' as const })
    )
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 12 }), (messages) => {
        const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, messages)
        const wireStrings = UrlParamMessage.reEncodeMessagesFromParams(url.search, bridges)
        const decoded = wireStrings.map((s): unknown => JSON.parse(s))
        expect(decoded).toEqual(messages)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('UrlParamMessage.stripMessageParams', () => {
  test('removes bridge params and preserves others', () => {
    const url = UrlParamMessage.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'x' },
    ])
    url.searchParams.append('keep', 'me')
    const stripped = UrlParamMessage.stripMessageParams(url.search, bridges)
    const reparsed = new URLSearchParams(stripped)
    expect(reparsed.get('Hello')).toBeNull()
    expect(reparsed.get('keep')).toBe('me')
  })
})

describe('UrlParamMessage.singleStringMessageSchema', () => {
  test('produces a Schema that round-trips string ↔ {_tag, field}', () => {
    const schema = UrlParamMessage.singleStringMessageSchema('Greet', 'msg')
    const encoded = Schema.encodeSync(schema)({ _tag: 'Greet' as const, msg: 'hi' })
    expect(encoded).toBe('hi')
    const decoded = Schema.decodeSync(schema)('hi')
    expect(decoded).toEqual({ _tag: 'Greet', msg: 'hi' })
  })
})

describe('UrlParamMessage.tagOnlyMessageSchema', () => {
  test('encodes to empty string and decodes back to {_tag}', () => {
    const schema = UrlParamMessage.tagOnlyMessageSchema('Buzz')
    const encoded = Schema.encodeSync(schema)({ _tag: 'Buzz' as const })
    expect(encoded).toBe('')
    const decoded = Schema.decodeSync(schema)('')
    expect(decoded).toEqual({ _tag: 'Buzz' })
  })
})
