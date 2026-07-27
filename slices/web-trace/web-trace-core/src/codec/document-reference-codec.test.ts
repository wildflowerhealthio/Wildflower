import { DateTime, Duration, Effect, Schema } from 'effect'
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
  TraceExchangeFromDocumentReference,
  TraceExchangeFromFhirJson,
  traceExchangeToWire,
} from './document-reference-codec.ts'
import {
  RESPONSE_HEADER_EXTENSION,
  RESPONSE_HEADER_NAME_EXTENSION,
  RESPONSE_HEADER_VALUE_EXTENSION,
  RESPONSE_HEADERS_EXTENSION,
  RESPONSE_STATUS_CODE_EXTENSION,
  RESPONSE_STATUS_EXTENSION,
  RESPONSE_STATUS_TEXT_EXTENSION,
  RESPONSE_TIMINGS_EXTENSION,
  TIMING_RECEIVE_EXTENSION,
  TIMING_WAIT_EXTENSION,
  UCUM_MILLISECOND_CODE,
  UCUM_SYSTEM,
  WEB_REQUEST_TRACE_CODE,
  WEB_TRACE_BASE,
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
      expect(outcome.left._tag).toBe('ParseError')
      expect(outcome.left.message).toContain(RESPONSE_STATUS_EXTENSION)
    }
  })

  test('a DocumentReference without the trace identifiers fails to decode', async () => {
    const resource = await Effect.runPromise(toDocumentReference(traceExchange()))
    const outcome = await Effect.runPromise(
      Effect.either(fromDocumentReference({ ...resource, identifier: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left._tag).toBe('ParseError')
      expect(outcome.left.message).toContain('identifier')
    }
  })

  test('a decode failure names the offending resource, so a failing page says which one', async () => {
    const exchange = traceExchange()
    const resource = await Effect.runPromise(toDocumentReference(exchange))
    const outcome = await Effect.runPromise(
      Effect.either(fromDocumentReference({ ...resource, extension: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.message).toContain(traceResourceId(exchange))
    }
  })

  test('timings ride as extensions and round-trip, including a half-measured pair', async () => {
    const exchange = traceExchange({ timings: { wait: Duration.millis(12.5), receive: null } })
    expect((await roundTrip(exchange)).timings).toEqual({
      wait: Duration.millis(12.5),
      receive: null,
    })
  })

  test('timings are valueDurations carrying their UCUM unit, not bare decimals', () => {
    const exchange = traceExchange({
      timings: { wait: Duration.millis(12.5), receive: Duration.millis(3) },
    })
    const timings = traceExchangeToWire(exchange).content[0]?.extension?.find(
      (entry) => entry.url === RESPONSE_TIMINGS_EXTENSION
    )?.extension
    expect(timings).toEqual([
      {
        url: TIMING_WAIT_EXTENSION,
        valueDuration: {
          value: 12.5,
          unit: UCUM_MILLISECOND_CODE,
          system: UCUM_SYSTEM,
          code: UCUM_MILLISECOND_CODE,
        },
      },
      {
        url: TIMING_RECEIVE_EXTENSION,
        valueDuration: {
          value: 3,
          unit: UCUM_MILLISECOND_CODE,
          system: UCUM_SYSTEM,
          code: UCUM_MILLISECOND_CODE,
        },
      },
    ])
  })

  test('property: every extension url on the wire is absolute, nested ones included', () => {
    // Sub-extensions may use a bare token per FHIR; this encoding does not, so a
    // url only meaningful next to its parent cannot creep back in.
    const urls = (extensions: readonly { url: string; extension?: unknown }[]): string[] =>
      extensions.flatMap((entry) => [
        entry.url,
        ...(Array.isArray(entry.extension)
          ? urls(entry.extension as readonly { url: string; extension?: unknown }[])
          : []),
      ])

    fc.assert(
      fc.property(exchangeArbitrary, (exchange) => {
        const wire = traceExchangeToWire(exchange)
        const all = [...urls(wire.extension ?? []), ...urls(wire.content[0]?.extension ?? [])]
        expect(all.length).toBeGreaterThan(0)
        for (const url of all) expect(url.startsWith(`${WEB_TRACE_BASE}/`)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('the status and header sub-extensions are the URLs systems.ts names', () => {
    const exchange = traceExchange({ headers: [['Accept', 'application/json']], status: 201 })
    const wire = traceExchangeToWire(exchange)
    expect(wire.extension?.[0]).toMatchObject({
      url: RESPONSE_STATUS_EXTENSION,
      extension: [
        { url: RESPONSE_STATUS_CODE_EXTENSION, valueInteger: 201 },
        { url: RESPONSE_STATUS_TEXT_EXTENSION, valueString: exchange.statusText },
      ],
    })
    expect(
      wire.content[0]?.extension?.find((entry) => entry.url === RESPONSE_HEADERS_EXTENSION)
        ?.extension
    ).toEqual([
      {
        url: RESPONSE_HEADER_EXTENSION,
        extension: [
          { url: RESPONSE_HEADER_NAME_EXTENSION, valueString: 'Accept' },
          { url: RESPONSE_HEADER_VALUE_EXTENSION, valueString: 'application/json' },
        ],
      },
    ])
  })
})

describe('the codec as a schema', () => {
  test('property: TraceExchangeFromDocumentReference round-trips, and is what the two directions are', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const resource = await Effect.runPromise(
          Schema.encode(TraceExchangeFromDocumentReference)(exchange)
        )
        const back = await Effect.runPromise(
          Schema.decode(TraceExchangeFromDocumentReference)(resource)
        )
        expect(comparable(back)).toEqual(comparable(exchange))
        expect(resource).toEqual(await Effect.runPromise(toDocumentReference(exchange)))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: TraceExchangeFromFhirJson round-trips straight from FHIR JSON', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const json: unknown = JSON.parse(
          JSON.stringify(
            await Effect.runPromise(Schema.encode(TraceExchangeFromFhirJson)(exchange))
          )
        )
        const back = await Effect.runPromise(Schema.decodeUnknown(TraceExchangeFromFhirJson)(json))
        expect(comparable(back)).toEqual(comparable(exchange))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('it composes like any other schema: a struct field decodes through it', async () => {
    const Envelope = Schema.Struct({ trace: TraceExchangeFromDocumentReference })
    const exchange = traceExchange()
    const resource = await Effect.runPromise(toDocumentReference(exchange))
    const decoded = await Effect.runPromise(Schema.decode(Envelope)({ trace: resource }))
    expect(comparable(decoded.trace)).toEqual(comparable(exchange))
  })

  test('a field that is present but ill-typed fails against TraceExchange, not a hand-written check', async () => {
    const resource = await Effect.runPromise(toDocumentReference(traceExchange()))
    const outcome = await Effect.runPromise(
      Effect.either(
        fromDocumentReference({
          ...resource,
          content: [
            {
              ...resource.content[0],
              attachment: { ...resource.content[0]?.attachment, size: -1 },
            },
          ],
        })
      )
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left._tag).toBe('ParseError')
  })
})
