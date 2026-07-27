import { HeadersWire, ResponseStartMessageBody, SnifferRequestId } from 'browser-sniffer-core'
import { DateTime, Duration, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { arbitraries, traceExchange } from './test-helpers.ts'
import { TraceExchange, traceResourceId } from './trace-exchange.ts'

const { exchange: exchangeArbitrary } = arbitraries(fc)

const encode = Schema.encodeSync(TraceExchange)
const decode = Schema.decodeUnknownSync(TraceExchange)

describe('TraceExchange', () => {
  test('the sniffer-observed fields are the sniffer schemas themselves, not copies of them', () => {
    // Referential identity, not structural equality: a copy would satisfy a
    // structural check on the day it was written and drift the day the sniffer
    // widened a range. This fails the moment somebody restates one inline.
    expect(TraceExchange.fields.url).toBe(ResponseStartMessageBody.fields.url)
    expect(TraceExchange.fields.status).toBe(ResponseStartMessageBody.fields.status)
    expect(TraceExchange.fields.statusText).toBe(ResponseStartMessageBody.fields.statusText)
    expect(TraceExchange.fields.headers).toBe(HeadersWire)
    expect(TraceExchange.fields.requestId).toBe(SnifferRequestId)
  })

  test('property: every generated exchange round-trips through its own schema', () => {
    fc.assert(
      fc.property(exchangeArbitrary, (exchange) => {
        expect(decode(encode(exchange))).toEqual(exchange)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: the resource id is {sessionId}-{requestId}', () => {
    fc.assert(
      fc.property(exchangeArbitrary, (exchange) => {
        expect(traceResourceId(exchange)).toBe(`${exchange.sessionId}-${exchange.requestId}`)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('two sessions recording the same request id get different resource ids', () => {
    const first = traceExchange({ sessionId: 'session-a', requestId: 'req-7' })
    const second = traceExchange({ sessionId: 'session-b', requestId: 'req-7' })
    expect(traceResourceId(first)).not.toBe(traceResourceId(second))
  })

  test('a status outside the sniffer-observable range is rejected', () => {
    // The range comes from the sniffer's own schema — `0` is what a WebView
    // reports for an opaque CORS response, and the upper slack absorbs custom
    // codes an intermediary injects.
    expect(() => decode({ ...encode(traceExchange({ status: 0 })), status: 0 })).not.toThrow()
    expect(() => decode({ ...encode(traceExchange()), status: 1001 })).toThrow()
    expect(() => decode({ ...encode(traceExchange()), status: 200.5 })).toThrow()
  })

  test('an empty request id is rejected, since it would merge unrelated exchanges', () => {
    expect(() => decode({ ...encode(traceExchange()), requestId: '' })).toThrow()
  })

  test('a stored body and a skipped body are distinguished by tag, not by an absent field', () => {
    const stored = traceExchange({
      body: {
        _tag: 'StoredBody',
        contentType: 'application/json',
        data: 'e30=',
        size: 2,
        hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
      },
    })
    const skipped = traceExchange({
      body: {
        _tag: 'SkippedBody',
        contentType: 'image/png',
        size: 918_273,
        hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        reason: 'Body exceeds the 2 MiB cap',
      },
    })
    expect(decode(encode(stored)).body).toEqual(stored.body)
    expect(decode(encode(skipped)).body).toEqual(skipped.body)
    // A skipped body still carries a size and a hash: a trace is explicit about
    // what it dropped, never silently lossy.
    expect(decode(encode(skipped)).body.size).toBe(918_273)
  })

  test('an unmeasured timing is null rather than zero, since zero is a measurement', () => {
    const exchange = traceExchange({ timings: { wait: Duration.zero, receive: null } })
    expect(decode(encode(exchange)).timings).toEqual({ wait: Duration.zero, receive: null })
  })

  test('timings are Durations in app and millisecond numbers on the wire', () => {
    // The unit lives in the encoded key, not in a field the app has to read.
    const exchange = traceExchange({
      timings: { wait: Duration.millis(12.5), receive: Duration.seconds(2) },
    })
    expect(encode(exchange).timings).toEqual({ waitMs: 12.5, receiveMs: 2000 })
    expect(decode(encode(exchange)).timings.receive).toStrictEqual(Duration.seconds(2))
  })

  test('an infinite timing is rejected, since JSON would turn it into "not measured"', () => {
    // `JSON.stringify(Infinity)` is `null`, which this schema reads as an
    // absence — so an infinite duration would come back a plausible lie.
    expect(() =>
      decode({ ...encode(traceExchange()), timings: { waitMs: Infinity, receiveMs: null } })
    ).toThrow()
    expect(() =>
      encode(traceExchange({ timings: { wait: Duration.infinity, receive: null } }))
    ).toThrow()
  })

  test('a negative timing is rejected rather than silently clamped to zero', () => {
    // `Duration.millis(-1)` is `Duration.zero`, so without the non-negative
    // filter on the encoded side a corrupt wire value would decode to a
    // plausible-looking measurement.
    expect(() =>
      decode({
        ...encode(traceExchange()),
        timings: { waitMs: -1, receiveMs: null },
      })
    ).toThrow()
  })

  test('startedAt survives the wire as the same instant', () => {
    const millis = Date.UTC(2024, 5, 14, 9, 41, 2, 123)
    const exchange = traceExchange({ startedAtMillis: millis })
    expect(DateTime.toEpochMillis(decode(encode(exchange)).startedAt)).toBe(millis)
  })
})
