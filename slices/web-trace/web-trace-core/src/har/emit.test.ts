// oxlint-disable import/max-dependencies -- HAR 1.2 is published as eighteen
// cross-referencing schema files; ajv needs every one registered before it can
// compile `har.json`, and splitting them across modules would only move the
// count, not reduce it.
import { Ajv } from 'ajv'
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' }
import { DateTime, Duration, Effect } from 'effect'
import * as fc from 'fast-check'
import afterRequestSchema from 'har-schema/lib/afterRequest.json' with { type: 'json' }
import beforeRequestSchema from 'har-schema/lib/beforeRequest.json' with { type: 'json' }
import browserSchema from 'har-schema/lib/browser.json' with { type: 'json' }
import cacheSchema from 'har-schema/lib/cache.json' with { type: 'json' }
import contentSchema from 'har-schema/lib/content.json' with { type: 'json' }
import cookieSchema from 'har-schema/lib/cookie.json' with { type: 'json' }
import creatorSchema from 'har-schema/lib/creator.json' with { type: 'json' }
import entrySchema from 'har-schema/lib/entry.json' with { type: 'json' }
import harSchema from 'har-schema/lib/har.json' with { type: 'json' }
import headerSchema from 'har-schema/lib/header.json' with { type: 'json' }
import logSchema from 'har-schema/lib/log.json' with { type: 'json' }
import pageSchema from 'har-schema/lib/page.json' with { type: 'json' }
import pageTimingsSchema from 'har-schema/lib/pageTimings.json' with { type: 'json' }
import postDataSchema from 'har-schema/lib/postData.json' with { type: 'json' }
import querySchema from 'har-schema/lib/query.json' with { type: 'json' }
import requestSchema from 'har-schema/lib/request.json' with { type: 'json' }
import responseSchema from 'har-schema/lib/response.json' with { type: 'json' }
import timingsSchema from 'har-schema/lib/timings.json' with { type: 'json' }
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { toDocumentReference } from '../codec/document-reference-codec.ts'
import { buildRedactionPolicy, redactSession } from '../pseudonymizer/redact.ts'
import { arbitraries, jsonBody, traceExchange } from '../test-helpers.ts'
import { noTimings } from '../trace-exchange.ts'
import type { TraceExchange } from '../trace-exchange.ts'
import { emitHar } from './emit.ts'
import type { Har } from './har.ts'

const { session: sessionArbitrary } = arbitraries(fc)

/**
 * The published HAR 1.2 schema, wired up as the authority this emitter is held
 * to. `strict` is off because the schema carries pre-draft keywords (`optional`,
 * `min`) that ajv would otherwise reject, and `validateFormats` is off because
 * ajv 8 ships no format validators — the one format that matters here,
 * `startedDateTime`, is also pinned by a `pattern` in the schema itself, which
 * does run.
 */
const validateHar = ((): ((value: unknown) => true | readonly string[]) => {
  const ajv = new Ajv({ strict: false, validateFormats: false })
  ajv.addMetaSchema(draft06)
  for (const schema of [
    afterRequestSchema,
    beforeRequestSchema,
    browserSchema,
    cacheSchema,
    contentSchema,
    cookieSchema,
    creatorSchema,
    entrySchema,
    headerSchema,
    logSchema,
    pageSchema,
    pageTimingsSchema,
    postDataSchema,
    querySchema,
    requestSchema,
    responseSchema,
    timingsSchema,
  ]) {
    ajv.addSchema(schema)
  }
  const validate = ajv.compile(harSchema)
  return (value: unknown) =>
    validate(value)
      ? true
      : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`)
})()

const emit = (exchanges: readonly TraceExchange[]): Har =>
  emitHar(exchanges, { sessionId: 'session-2f8c', creatorVersion: '1.0.0' })

describe('emitHar', () => {
  test('property: every emitted archive validates against the HAR 1.2 schema', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        expect(validateHar(emit(session))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('the schema check can fail — a missing required field is caught', () => {
    const archive = emit([traceExchange()])
    const broken = {
      log: {
        ...archive.log,
        entries: archive.log.entries.map((entry) => ({ ...entry, timings: undefined })),
      },
    }
    expect(validateHar(broken)).not.toBe(true)
  })

  test('request.method is UNKNOWN, with a comment saying why rather than a guessed GET', () => {
    const [entry] = emit([traceExchange()]).log.entries
    expect(entry?.request.method).toBe('UNKNOWN')
    expect(entry?.request.comment).toContain('never observed')
    expect(entry?.request.comment).toContain('UNKNOWN rather than guessed as GET')
    expect(entry?.request.headers).toEqual([])
  })

  test('query parameters are carried on the request even though nothing else about it was seen', () => {
    const [entry] = emit([
      traceExchange({ url: 'https://portal.example.org/api/v2/patients?q=ada&page=2' }),
    ]).log.entries
    expect(entry?.request.queryString).toEqual([
      { name: 'q', value: 'ada' },
      { name: 'page', value: '2' },
    ])
  })

  test('unmeasured timings are -1, and so is the total when nothing was measured', () => {
    const [entry] = emit([traceExchange({ timings: noTimings })]).log.entries
    expect(entry?.timings).toEqual({ send: -1, wait: -1, receive: -1 })
    expect(entry?.time).toBe(-1)
  })

  test('a measured phase is reported and totalled, with the unmeasured ones still -1', () => {
    const [entry] = emit([
      traceExchange({ timings: { wait: Duration.millis(12), receive: Duration.millis(30) } }),
    ]).log.entries
    expect(entry?.timings).toEqual({ send: -1, wait: 12, receive: 30 })
    expect(entry?.time).toBe(42)
  })

  test('a stored body rides as base64 text', () => {
    const data = jsonBody({ a: 1 })
    const [entry] = emit([
      traceExchange({
        body: { _tag: 'StoredBody', contentType: 'application/json', data, size: 7, hash: 'h' },
      }),
    ]).log.entries
    expect(entry?.response.content).toEqual({
      size: 7,
      mimeType: 'application/json',
      text: data,
      encoding: 'base64',
    })
  })

  test('a policy-skipped body has a size, no text, and a comment naming the reason', () => {
    const [entry] = emit([
      traceExchange({
        body: {
          _tag: 'SkippedBody',
          contentType: 'image/png',
          size: 918_273,
          hash: 'h',
          reason: 'Body exceeds the 2 MiB cap',
        },
      }),
    ]).log.entries
    expect(entry?.response.content.size).toBe(918_273)
    expect(entry?.response.content.text).toBeUndefined()
    expect(entry?.response.content.comment).toContain('Body exceeds the 2 MiB cap')
    expect(entry?.response.content.comment).toContain('not stored by the capture policy')
  })

  test('log.creator names Wildflower and the session', () => {
    expect(emit([traceExchange()]).log.creator).toEqual({
      name: 'Wildflower Web Trace',
      version: '1.0.0',
      comment: 'Session session-2f8c',
    })
    expect(emit([traceExchange()]).log.version).toBe('1.2')
  })

  test('property: entries come out ordered by startedDateTime', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        const times = emit(session).log.entries.map((entry) => Date.parse(entry.startedDateTime))
        expect(times).toEqual([...times].toSorted((left, right) => left - right))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('response headers and status survive to the archive', () => {
    const [entry] = emit([
      traceExchange({
        status: 404,
        statusText: 'Not Found',
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Request-Id', 'abc'],
        ],
      }),
    ]).log.entries
    expect(entry?.response.status).toBe(404)
    expect(entry?.response.statusText).toBe('Not Found')
    expect(entry?.response.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Request-Id', value: 'abc' },
    ])
  })
})

describe('a redacted HAR is usable as a fixture', () => {
  /** Reads a HAR entry back as the exchange it describes — what a fixture consumer does. */
  const exchangeFromEntry = (
    entry: Har['log']['entries'][number],
    index: number
  ): TraceExchange => ({
    sessionId: 'fixture',
    requestId: `req-${index}`,
    url: entry.request.url,
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers: entry.response.headers.map(({ name, value }) => [name, value] as const),
    startedAt: DateTime.unsafeMake(Date.parse(entry.startedDateTime)),
    timings: {
      wait: entry.timings.wait < 0 ? null : Duration.millis(entry.timings.wait),
      receive: entry.timings.receive < 0 ? null : Duration.millis(entry.timings.receive),
    },
    body:
      entry.response.content.text === undefined
        ? {
            _tag: 'SkippedBody',
            contentType: entry.response.content.mimeType,
            size: entry.response.content.size,
            hash: '',
            reason: entry.response.content.comment ?? '',
          }
        : {
            _tag: 'StoredBody',
            contentType: entry.response.content.mimeType,
            data: entry.response.content.text,
            size: entry.response.content.size,
            hash: '',
          },
    // HAR 1.2 has no field for "the resources this response produced", so an
    // exported archive cannot carry the provenance link and a reader cannot
    // recover it. Empty here states that, rather than inventing one.
    producedResources: [],
  })

  test('property: a redacted session emits a valid HAR that reads back into encodable exchanges', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await Effect.runPromise(
          buildRedactionPolicy(session, { salt: 'fixture-salt' }).pipe(
            Effect.flatMap((policy) => redactSession(policy, session))
          )
        )
        const archive = emitHar(redacted, { sessionId: 'redacted-session' })
        expect(validateHar(archive)).toBe(true)

        const rebuilt = archive.log.entries.map(exchangeFromEntry)
        expect(rebuilt).toHaveLength(session.length)
        // Usable means: the fixture goes back through the codec, which is the
        // path a collector test would take to seed a store from a shared HAR.
        const resources = await Effect.runPromise(
          Effect.all(rebuilt.map((exchange) => toDocumentReference(exchange)))
        )
        expect(resources.map((resource) => resource.resourceType)).toEqual(
          rebuilt.map(() => 'DocumentReference')
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})
