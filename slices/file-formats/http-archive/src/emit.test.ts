// oxlint-disable import/max-dependencies -- HAR 1.2 is published as eighteen
// cross-referencing schema files; ajv needs every one registered before it can
// compile `har.json`, and splitting them across modules would only move the
// count, not reduce it.
import { Ajv } from 'ajv'
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' }
import { DateTime, Duration, Schema } from 'effect'
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

import { noTimings } from 'web-trace-core'
import type { TraceExchange } from 'web-trace-core'
import { arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'
import { CREATOR_NAME, DROPPED_REQUEST_ON_IMPORT_COMMENT, emitHar, emitHarFromLog } from './emit.ts'
import { Har } from './har.ts'
import type * as HttpArchive from './http-archive.ts'

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

/**
 * The archive as it is written to a file. `har-schema` describes the JSON, so
 * the schema check has to run on the encoded side, not on the decoded values
 * `emitHar` builds.
 */
const encode = Schema.encodeSync(Har)

describe('emitHar', () => {
  test('property: every emitted archive validates against the HAR 1.2 schema', () => {
    fc.assert(
      fc.property(sessionArbitrary, (session) => {
        expect(validateHar(encode(emit(session)))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('the schema check can fail — a missing required field is caught', () => {
    const archive = encode(emit([traceExchange()]))
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
      body: { _tag: 'HarBase64Body', text: data },
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
    expect(entry?.response.content.body).toEqual({ _tag: 'HarNoBody' })
    expect(entry?.response.content.comment).toContain('Body exceeds the 2 MiB cap')
    expect(entry?.response.content.comment).toContain('See the reason field for details')
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
        const times = emit(session).log.entries.map((entry) =>
          DateTime.toEpochMillis(entry.startedDateTime)
        )
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
      ['Content-Type', 'application/json'],
      ['X-Request-Id', 'abc'],
    ])
  })
})

/**
 * One settled entry, in the shape the {@link HttpArchive.Log} projection holds
 * it. The fields the creator/request options do not touch are fixed here so a
 * failure names the option, not the fixture.
 */
const logOf = (): HttpArchive.Log => ({
  version: '1.2',
  entries: [
    {
      id: 'har-entry-0',
      url: 'https://portal.example.org/api/v2/patients',
      method: 'UNKNOWN',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      startedAt: DateTime.unsafeMake('2026-09-13T14:02:11Z'),
      body: new TextEncoder().encode('{"ok":true}'),
      bodyAbsent: false,
    },
  ],
})

describe('emitHarFromLog', () => {
  test('names the web trace and states the import-dropped request side by default', () => {
    const archive = emitHarFromLog(logOf())
    expect(archive.log.creator.name).toBe(CREATOR_NAME)
    expect(archive.log.entries[0]?.request.comment).toBe(DROPPED_REQUEST_ON_IMPORT_COMMENT)
  })

  test('creatorName names a different producer on log.creator', () => {
    const archive = emitHarFromLog(logOf(), { creatorName: 'Wildflower HAR Recorder' })
    expect(archive.log.creator.name).toBe('Wildflower HAR Recorder')
    // The override replaces the name only; the version keeps its own default.
    expect(archive.log.creator.version).toBe('0')
  })

  test('property: requestComment lands on every entry request, replacing the default', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (requestComment) => {
        const archive = emitHarFromLog(logOf(), { requestComment })
        expect(archive.log.entries.map((entry) => entry.request.comment)).toEqual([requestComment])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('an archive emitted with both overrides still validates against the HAR 1.2 schema', () => {
    const archive = emitHarFromLog(logOf(), {
      creatorName: 'Wildflower HAR Recorder',
      requestComment: 'The request side was never observed.',
    })
    expect(validateHar(encode(archive))).toBe(true)
  })
})
