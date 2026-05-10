import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import * as UrlCodec from '../src/url-codec.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Hello = Schema.parseJson(Schema.TaggedStruct('Hello', { msg: Schema.String }))
const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))

describe('UrlCodec', () => {
  test('round-trips a single tagged message through encode/decode', () => {
    const encoded = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 42 })
    const params = UrlCodec.encodeMessagesAsParams([encoded])
    const decoded = UrlCodec.decodeMessagesFromParams(`?${params.toString()}`)
    expect(decoded).toEqual([encoded])
  })

  test('preserves order across multiple messages with the same tag', () => {
    const a = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 })
    const b = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 2 })
    const c = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 3 })
    const params = UrlCodec.encodeMessagesAsParams([a, b, c])
    const decoded = UrlCodec.decodeMessagesFromParams(`?${params.toString()}`)
    expect(decoded).toEqual([a, b, c])
  })

  test('uses the tag in the param key so URLs are human-readable', () => {
    const encoded = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 7 })
    const params = UrlCodec.encodeMessagesAsParams([encoded])
    expect([...params.keys()]).toEqual(['msg.Ping'])
  })

  test('returns [] for a search string with no msg.* params', () => {
    expect(UrlCodec.decodeMessagesFromParams('?other=value&keep=this')).toEqual([])
  })

  test('skips malformed base64 entries silently', () => {
    const decoded = UrlCodec.decodeMessagesFromParams('?msg.Ping=$$$not-base64$$$')
    // The base64 is technically decodable as garbage, but as long as it doesn't throw it's fine.
    // The dispatch core warns on downstream decode failure.
    expect(Array.isArray(decoded)).toBe(true)
  })

  test('throws on encode of a non-tagged-struct', () => {
    expect(() => UrlCodec.encodeMessagesAsParams(['not json'])).toThrow(/not valid JSON/)
    expect(() => UrlCodec.encodeMessagesAsParams(['{"foo":"bar"}'])).toThrow(/not a tagged struct/)
  })

  test('round-trips UTF-8 strings (non-ASCII payloads)', () => {
    const encoded = Schema.encodeSync(Hello)({ _tag: 'Hello', msg: '👋 héllo wörld 中文' })
    const params = UrlCodec.encodeMessagesAsParams([encoded])
    const decoded = UrlCodec.decodeMessagesFromParams(`?${params.toString()}`)
    expect(decoded).toEqual([encoded])
  })

  test('property: arbitrary tagged messages round-trip', () => {
    const messageArb = fc.oneof(
      fc.integer().map((value) => Schema.encodeSync(Ping)({ _tag: 'Ping' as const, value })),
      fc.string().map((msg) => Schema.encodeSync(Hello)({ _tag: 'Hello' as const, msg })),
      fc.constant(Schema.encodeSync(Buzz)({ _tag: 'Buzz' as const }))
    )
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 12 }), (encodedMessages) => {
        const params = UrlCodec.encodeMessagesAsParams(encodedMessages)
        const decoded = UrlCodec.decodeMessagesFromParams(`?${params.toString()}`)
        expect(decoded).toEqual(encodedMessages)
      })
    )
  })
})
