import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import * as Bridge from '../src/bridge.ts'
import * as UrlCodec from '../src/url-codec.ts'

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
    Hello: UrlCodec.tagAndField('Hello', 'msg'),
    Ping: UrlCodec.tagAndField('Ping', 'value'),
    Buzz: UrlCodec.tagOnly('Buzz'),
  },
})
const bridges = [TestBridge] as const

const baseUrl = (): URL => new URL('https://app.local/')

describe('UrlCodec', () => {
  test('encodes a single-field message as ?<Tag>=<value>', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Hello', msg: 'world' }])
    expect(url.searchParams.get('Hello')).toBe('world')
  })

  test('round-trips through encode → decode', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Hello', msg: 'world' }])
    const wireStrings = UrlCodec.decodeMessagesFromParams(url.search, bridges)
    expect(wireStrings).toHaveLength(1)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({ _tag: 'Hello', msg: 'world' })
  })

  test('payload-less tag-only messages render as ?<Tag> without =', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Buzz' }])
    expect(url.search).toBe('?Buzz')
    const wireStrings = UrlCodec.decodeMessagesFromParams(url.search, bridges)
    expect(wireStrings).toHaveLength(1)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({ _tag: 'Buzz' })
  })

  test('uses the tag as the URL key (no msg. prefix)', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Hello', msg: 'hi' }])
    expect([...url.searchParams.keys()]).toEqual(['Hello'])
  })

  test('returns [] for a search string with no bridge params', () => {
    expect(UrlCodec.decodeMessagesFromParams('?other=value&keep=this', bridges)).toEqual([])
  })

  test('throws on encode of a tag without a urlParams schema', () => {
    const NoFlag = Schema.parseJson(Schema.TaggedStruct('NoFlag', {}))
    const NoUrlParamsBridge = Bridge.make({
      name: 'NoUrl',
      hostToWeb: [['NoFlag', NoFlag]] as const,
      webToHost: [] as const,
    })
    expect(() =>
      UrlCodec.appendMessagesToUrl(baseUrl(), [NoUrlParamsBridge], [{ _tag: 'NoFlag' }])
    ).toThrow(/no urlParams schema/)
  })

  test('round-trips UTF-8 strings (non-ASCII payloads)', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: '👋 héllo wörld 中文' },
    ])
    const wireStrings = UrlCodec.decodeMessagesFromParams(url.search, bridges)
    expect(JSON.parse(wireStrings[0] ?? '')).toEqual({
      _tag: 'Hello',
      msg: '👋 héllo wörld 中文',
    })
  })

  test('multiple messages preserve order', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [
      { _tag: 'Hello', msg: 'first' },
      { _tag: 'Ping', value: 'second' },
      { _tag: 'Buzz' },
    ])
    const wireStrings = UrlCodec.decodeMessagesFromParams(url.search, bridges)
    expect(wireStrings.map((s) => JSON.parse(s))).toEqual([
      { _tag: 'Hello', msg: 'first' },
      { _tag: 'Ping', value: 'second' },
      { _tag: 'Buzz' },
    ])
  })

  test('property: arbitrary single-field messages round-trip', () => {
    const messageArb = fc.oneof(
      fc.string().map((msg) => ({ _tag: 'Hello' as const, msg })),
      fc.string().map((value) => ({ _tag: 'Ping' as const, value })),
      fc.constant({ _tag: 'Buzz' as const })
    )
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 12 }), (messages) => {
        const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, messages)
        const wireStrings = UrlCodec.decodeMessagesFromParams(url.search, bridges)
        const decoded = wireStrings.map((s): unknown => JSON.parse(s))
        expect(decoded).toEqual(messages)
      })
    )
  })
})

describe('UrlCodec.stripMessageParams', () => {
  test('removes bridge params and preserves others', () => {
    const url = UrlCodec.appendMessagesToUrl(baseUrl(), bridges, [{ _tag: 'Hello', msg: 'x' }])
    url.searchParams.append('keep', 'me')
    const stripped = UrlCodec.stripMessageParams(url.search, bridges)
    const reparsed = new URLSearchParams(stripped)
    expect(reparsed.get('Hello')).toBeNull()
    expect(reparsed.get('keep')).toBe('me')
  })
})

describe('UrlCodec.tagAndField', () => {
  test('produces a Schema that round-trips string ↔ {_tag, field}', () => {
    const schema = UrlCodec.tagAndField('Greet', 'msg')
    const encoded = Schema.encodeSync(schema)({ _tag: 'Greet' as const, msg: 'hi' })
    expect(encoded).toBe('hi')
    const decoded = Schema.decodeSync(schema)('hi')
    expect(decoded).toEqual({ _tag: 'Greet', msg: 'hi' })
  })
})

describe('UrlCodec.tagOnly', () => {
  test('encodes to empty string and decodes back to {_tag}', () => {
    const schema = UrlCodec.tagOnly('Buzz')
    const encoded = Schema.encodeSync(schema)({ _tag: 'Buzz' as const })
    expect(encoded).toBe('')
    const decoded = Schema.decodeSync(schema)('')
    expect(decoded).toEqual({ _tag: 'Buzz' })
  })
})
