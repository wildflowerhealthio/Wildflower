// oxlint-disable import/max-dependencies -- HAR 1.2 is published as eighteen
// cross-referencing schema files; ajv needs every one registered before it can
// compile `har.json`, and splitting them across modules would only move the
// count, not reduce it.
import { Ajv } from 'ajv'
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' }
import { Duration, Effect, Schema } from 'effect'
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

import { emitHar, Har } from 'har-importer-core/har'
import type { TraceExchange } from 'web-trace-core'
import { toDocumentReference } from 'web-trace-core/codec'
import { arbitraries } from 'web-trace-core/test-helpers'

import { buildRedactionPolicy, redactSession } from './redact.ts'

/**
 * The redaction → emit seam, held to the published HAR 1.2 schema: the whole
 * point of an anonymized export is that someone else can consume it as a
 * fixture, so a redacted session has to emit a schema-valid archive that reads
 * back into codec-encodable exchanges. Lives here rather than beside the
 * emitter because the emitter does not know redaction exists — this is the
 * anonymizer's obligation, not the archive format's.
 */

const { session: sessionArbitrary } = arbitraries(fc)

/**
 * The published HAR 1.2 schema, wired up as the authority the emitted fixture
 * is held to. `strict` is off because the schema carries pre-draft keywords
 * (`optional`, `min`) that ajv would otherwise reject, and `validateFormats`
 * is off because ajv 8 ships no format validators — the one format that
 * matters here, `startedDateTime`, is also pinned by a `pattern` in the schema
 * itself, which does run.
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

/**
 * The archive as it is written to a file. `har-schema` describes the JSON, so
 * the schema check has to run on the encoded side, not on the decoded values
 * `emitHar` builds.
 */
const encode = Schema.encodeSync(Har)

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
    headers: entry.response.headers,
    startedAt: entry.startedDateTime,
    timings: {
      wait: entry.timings.wait < 0 ? null : Duration.millis(entry.timings.wait),
      receive: entry.timings.receive < 0 ? null : Duration.millis(entry.timings.receive),
    },
    body:
      entry.response.content.body._tag === 'HarBase64Body'
        ? {
            _tag: 'StoredBody',
            contentType: entry.response.content.mimeType,
            data: entry.response.content.body.text,
            size: entry.response.content.size,
            hash: '',
          }
        : {
            _tag: 'SkippedBody',
            contentType: entry.response.content.mimeType,
            size: entry.response.content.size,
            hash: '',
            reason: entry.response.content.comment ?? '',
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
        expect(validateHar(encode(archive))).toBe(true)

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
