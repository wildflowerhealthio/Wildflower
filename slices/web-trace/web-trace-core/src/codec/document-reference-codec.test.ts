import { DateTime, Duration, Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { arbitraries, traceExchange } from '../test-helpers.ts'
import type { TraceExchange } from '../trace-exchange.ts'
import { traceResourceId } from '../trace-exchange.ts'
import {
  fromDocumentReference,
  isWebTrace,
  toDocumentReference,
  traceExchangeToWire,
} from './document-reference-codec.ts'
import {
  WEB_REQUEST_TRACE_CODE,
  WEB_TRACE_CATEGORY_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from './systems.ts'

const { exchange: exchangeArbitrary } = arbitraries(fc)

/** `DateTime.Utc` values compare by identity under `toEqual`; compare the instants instead. */
const comparable = (
  exchange: TraceExchange
): Omit<TraceExchange, 'startedAt'> & { readonly startedAtMillis: number } => {
  const { startedAt, ...rest } = exchange
  return { ...rest, startedAtMillis: DateTime.toEpochMillis(startedAt) }
}

const roundTrip = (exchange: TraceExchange): Promise<TraceExchange> =>
  Effect.runPromise(toDocumentReference(exchange).pipe(Effect.flatMap(fromDocumentReference)))

describe('TraceExchange ⇄ DocumentReference', () => {
  test('property: every exchange round-trips through a DocumentReference without loss', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        expect(comparable(await roundTrip(exchange))).toEqual(comparable(exchange))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: the resource id is {sessionId}-{requestId}, so a retried write is an upsert', () => {
    fc.assert(
      fc.property(exchangeArbitrary, (exchange) => {
        expect(traceExchangeToWire(exchange).id).toBe(`${exchange.sessionId}-${exchange.requestId}`)
        expect(traceExchangeToWire(exchange).id).toBe(traceResourceId(exchange))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: subject is absent, keeping traces out of Patient/$everything', () => {
    fc.assert(
      fc.property(exchangeArbitrary, (exchange) => {
        expect(traceExchangeToWire(exchange).subject).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a stored body carries data, size and hash', async () => {
    const exchange = traceExchange({
      body: {
        _tag: 'StoredBody',
        contentType: 'application/fhir+json',
        data: 'eyJhIjoxfQ==',
        size: 9,
        hash: 'DEADBEEF/hash+base64=',
      },
    })
    const wire = traceExchangeToWire(exchange)
    expect(wire.content[0]?.attachment).toMatchObject({
      contentType: 'application/fhir+json',
      data: 'eyJhIjoxfQ==',
      size: 9,
      hash: 'DEADBEEF/hash+base64=',
      title: exchange.url,
    })
    expect(comparable(await roundTrip(exchange))).toEqual(comparable(exchange))
  })

  test('a skipped body stores size and hash with no data, and says why', async () => {
    const exchange = traceExchange({
      body: {
        _tag: 'SkippedBody',
        contentType: 'image/png',
        size: 918_273,
        hash: 'DEADBEEF/hash+base64=',
        reason: 'Body exceeds the 2 MiB cap',
      },
    })
    const attachment = traceExchangeToWire(exchange).content[0]?.attachment
    expect(attachment?.data).toBeUndefined()
    expect(attachment?.size).toBe(918_273)
    expect(attachment?.hash).toBe('DEADBEEF/hash+base64=')

    const decoded = await roundTrip(exchange)
    expect(decoded.body).toEqual(exchange.body)
  })

  test('repeated header names survive; a Record would collapse them', async () => {
    const exchange = traceExchange({
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ],
    })
    expect((await roundTrip(exchange)).headers).toEqual(exchange.headers)
  })

  test('type, category and securityLabel carry the private web-trace codings', () => {
    const wire = traceExchangeToWire(traceExchange())
    expect(wire.type?.coding).toEqual([
      { system: WEB_TRACE_CODE_SYSTEM, code: WEB_REQUEST_TRACE_CODE },
    ])
    expect(wire.category).toEqual([
      { coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: WEB_TRACE_CATEGORY_CODE }] },
    ])
    expect(wire.securityLabel).toEqual([
      { coding: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }] },
    ])
    expect(wire.status).toBe('current')
  })

  test('description renders the url and status for a human reader', () => {
    const exchange = traceExchange({ url: 'https://portal.example.org/api/v2/x', status: 404 })
    expect(traceExchangeToWire(exchange).description).toBe(
      'https://portal.example.org/api/v2/x → 404'
    )
  })

  test('property: isWebTrace holds for encoded traces, so category search finds them', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        expect(isWebTrace(await Effect.runPromise(toDocumentReference(exchange)))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a DocumentReference without the status extension fails to decode', async () => {
    const resource = await Effect.runPromise(toDocumentReference(traceExchange()))
    const outcome = await Effect.runPromise(
      Effect.either(fromDocumentReference({ ...resource, extension: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left._tag).toBe('TraceDecodeError')
      expect(outcome.left.reason).toContain('web-trace-response-status')
    }
  })

  test('a DocumentReference without the trace identifiers fails to decode', async () => {
    const resource = await Effect.runPromise(toDocumentReference(traceExchange()))
    const outcome = await Effect.runPromise(
      Effect.either(fromDocumentReference({ ...resource, identifier: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.reason).toContain('identifier')
    }
  })

  test('timings ride as extensions and round-trip, including a half-measured pair', async () => {
    const exchange = traceExchange({ timings: { wait: Duration.millis(12.5), receive: null } })
    expect((await roundTrip(exchange)).timings).toEqual({
      wait: Duration.millis(12.5),
      receive: null,
    })
  })
})
