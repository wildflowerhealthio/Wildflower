import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { DateTime, Duration, Effect, Either, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { DocumentReference } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { traceResourceId } from 'web-trace-core'
import { type DocumentReferenceType, fromDocumentReference, isWebTrace } from 'web-trace-core/codec'

import { BodyDigestUnavailable } from 'web-trace-core/capture'

import type { BodyPolicy } from '../body-policy.ts'
import { DEFAULT_BODY_CONTENT_TYPES, DEFAULT_MAX_BODY_BYTES } from '../config.ts'
import { digestFailureAsParseError, makeRawExchangeEntity } from './raw-exchange-entity.ts'

const { expectRightToEqual } = utilityExpectations(expect)

/** Back to the FHIR JSON that is actually persisted — the form FHIR search sees. */
const encodeResource = Schema.encode(DocumentReference.Schema)

const SESSION_ID = 'session-abc'
const STARTED_AT = DateTime.unsafeMake('2026-01-01T00:00:00.000Z')

const defaultPolicy: BodyPolicy = {
  bodyContentTypes: DEFAULT_BODY_CONTENT_TYPES,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
}

const entity = makeRawExchangeEntity({ sessionId: SESSION_ID, policy: defaultPolicy })

const parse = (
  overrides: Parameters<typeof makeCollectorHttpResponse>[0] = {},
  definition = entity
): Promise<readonly DocumentReferenceType[]> =>
  Effect.runPromise(definition.parse(makeCollectorHttpResponse({ startedAt: STARTED_AT, ...overrides })))

/** The single resource a parse of one exchange produces. */
const parseOne = async (
  overrides: Parameters<typeof makeCollectorHttpResponse>[0] = {},
  definition = entity
): Promise<DocumentReferenceType> => {
  const resources = await parse(overrides, definition)
  expect(resources).toHaveLength(1)
  const [resource] = resources
  if (resource === undefined) throw new Error('unreachable: length asserted above')
  return resource
}

describe('isFoundAt', () => {
  // The catch-all is load-bearing twice over: it is what records everything,
  // and it is what stops `CollectorBridgeMessageHandler` from firing
  // `CancelSnifferRequest` at responses no entity claims — which would abort
  // the very requests the user's browsing depends on. A narrowing regression
  // here breaks the page in front of the user, not just the recording.
  it('claims every URL, including ones no collector would normally recognize', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        expect(entity.isFoundAt(url)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    'https://portal.example.com/api/patients',
    'https://cdn.example.com/bundle.a1b2c3.js',
    'https://portal.example.com/favicon.ico',
    'not-even-a-url',
    '',
  ])('claims %j', (url) => {
    expect(entity.isFoundAt(url)).toBe(true)
  })
})

describe('parse', () => {
  it('emits exactly one DocumentReference per exchange', async () => {
    await expect(parse()).resolves.toHaveLength(1)
  })

  it('produces a resource the codec recognizes as a web trace', async () => {
    expect(isWebTrace(await parseOne())).toBe(true)
  })

  it('ids the resource from (sessionId, requestId), so a retried write is an upsert', async () => {
    const resource = await parseOne({ id: 'req-77' })
    expect(resource.id).toBe(traceResourceId({ sessionId: SESSION_ID, requestId: 'req-77' }))
  })

  it('leaves subject absent, keeping traces out of Patient/$everything', async () => {
    // The epic's decision, enforced by the codec; asserted here because it is
    // this collector's write that would otherwise leak a trace into a clinical
    // export.
    const resource = await parseOne()
    expect(resource.subject).toBeUndefined()
    // Round-tripped through JSON because that is what is actually PUT: the
    // encoder leaves a `subject` key holding `undefined`, which `JSON.stringify`
    // drops. Asserting on the encoded object alone would pass on a `null` too.
    const wire: unknown = JSON.parse(
      JSON.stringify(await Effect.runPromise(encodeResource(resource)))
    )
    expect(wire).not.toHaveProperty('subject')
  })

  it('round-trips back through the codec to the exchange that was captured', async () => {
    const resource = await parseOne({
      id: 'req-9',
      url: 'https://portal.example.com/api/patients?q=smith',
      status: 201,
      statusText: 'Created',
      headers: [
        ['content-type', 'application/fhir+json'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      body: '{"ok":true}',
    })

    const exchange = await Effect.runPromise(fromDocumentReference(resource))
    expect(exchange).toMatchObject({
      sessionId: SESSION_ID,
      requestId: 'req-9',
      url: 'https://portal.example.com/api/patients?q=smith',
      status: 201,
      statusText: 'Created',
      // Repeated headers survive in order — a `Record` would have collapsed them.
      headers: [
        ['content-type', 'application/fhir+json'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      body: { _tag: 'StoredBody', contentType: 'application/fhir+json' },
    })
    expect(DateTime.toEpochMillis(exchange.startedAt)).toBe(DateTime.toEpochMillis(STARTED_AT))
  })

  it('records the response start it observed, not the moment it parsed', async () => {
    const startedAt = DateTime.unsafeMake('2019-06-05T12:34:56.000Z')
    const exchange = await Effect.runPromise(fromDocumentReference(await parseOne({ startedAt })))
    expect(DateTime.toEpochMillis(exchange.startedAt)).toBe(DateTime.toEpochMillis(startedAt))
  })

  it('reports no wait timing, because nothing observes the request side', async () => {
    const exchange = await Effect.runPromise(fromDocumentReference(await parseOne()))
    expect(exchange.timings.wait).toBeNull()
  })

  it('measures receive as a real, non-negative duration', async () => {
    // `startedAt` is `DateTime.now`-relative so the measured span is small and
    // real, rather than the ~7 years a fixed 2026 timestamp would produce.
    const startedAt = await Effect.runPromise(DateTime.now)
    const exchange = await Effect.runPromise(fromDocumentReference(await parseOne({ startedAt })))

    expect(exchange.timings.receive).not.toBeNull()
    const receive = exchange.timings.receive
    if (receive === null) return
    expect(Duration.toMillis(receive)).toBeGreaterThanOrEqual(0)
    expect(Duration.toMillis(receive)).toBeLessThan(60_000)
  })

  describe('the body policy governs bodies, never whether an exchange is recorded', () => {
    it.each([
      ['an off-allowlist binary body', 'image/png', 'SkippedBody'],
      ['an allowlisted JSON body', 'application/json', 'StoredBody'],
      ['a body with no stated content type', undefined, 'SkippedBody'],
    ])('still emits a DocumentReference for %s', async (_label, contentType, expectedBodyTag) => {
      const resource = await parseOne({
        headers: contentType === undefined ? [] : [['content-type', contentType]],
        body: 'some bytes',
      })
      const exchange = await Effect.runPromise(fromDocumentReference(resource))
      expect(exchange.body._tag).toBe(expectedBodyTag)
    })

    it('records an over-cap body as skipped, with its size and hash preserved', async () => {
      const tiny = makeRawExchangeEntity({
        sessionId: SESSION_ID,
        policy: { bodyContentTypes: ['json'], maxBodyBytes: 2 },
      })
      const exchange = await Effect.runPromise(
        fromDocumentReference(
          await parseOne({ headers: [['content-type', 'application/json']], body: '{"a":1}' }, tiny)
        )
      )

      expect(exchange.body).toMatchObject({ _tag: 'SkippedBody', size: 7 })
      expect(exchange.body.hash).not.toBe('')
    })

    it('never filters by URL — every URL is recorded whatever the allowlist says', async () => {
      const nothingStored = makeRawExchangeEntity({
        sessionId: SESSION_ID,
        policy: { bodyContentTypes: [], maxBodyBytes: 0 },
      })
      await fc.assert(
        fc.asyncProperty(fc.webUrl(), async (url) => {
          const exchange = await Effect.runPromise(
            fromDocumentReference(await parseOne({ url }, nothingStored))
          )
          expect(exchange.url).toBe(url)
          expect(exchange.body._tag).toBe('SkippedBody')
        }),
        { numRuns: numRunsFor({ base: 25 }) }
      )
    })
  })

  it('stores what was seen, unredacted — redaction is an export-time concern', async () => {
    // Invariant 2. If a redactor is ever wired into this write path, this fails.
    const body = '{"patientId":"1234567890","email":"jane@example.com"}'
    const exchange = await Effect.runPromise(
      fromDocumentReference(
        await parseOne({ headers: [['content-type', 'application/json']], body })
      )
    )

    expect(exchange.body._tag).toBe('StoredBody')
    if (exchange.body._tag !== 'StoredBody') return
    expect(new TextDecoder().decode(Buffer.from(exchange.body.data, 'base64'))).toBe(body)
  })

  it('round-trips any capture through the codec without loss', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
          url: fc.webUrl(),
          status: fc.integer({ min: 0, max: 1000 }),
          statusText: fc.string({ maxLength: 40 }),
          body: fc.uint8Array({ maxLength: 256 }),
        }),
        fc.constantFrom('application/json', 'text/html', 'image/png', 'application/octet-stream'),
        async ({ id, url, status, statusText, body }, contentType) => {
          const exchange = await Effect.runPromise(
            fromDocumentReference(
              await parseOne({
                id,
                url,
                status,
                statusText,
                headers: [['content-type', contentType]],
                body,
              })
            )
          )
          expect(exchange).toMatchObject({ sessionId: SESSION_ID, requestId: id, url, status })
          expect(exchange.body.size).toBe(body.length)
          expect(exchange.body.contentType).toBe(contentType)
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('distinguishes two sessions recording the same request id', async () => {
    const other = makeRawExchangeEntity({ sessionId: 'session-xyz', policy: defaultPolicy })
    const [a, b] = await Promise.all([parseOne({ id: 'req-1' }), parseOne({ id: 'req-1' }, other)])
    expect(a.id).not.toBe(b.id)
  })
})

describe('digestFailureAsParseError', () => {
  it('re-raises a digest failure as a ParseError naming the real reason', () => {
    const error = digestFailureAsParseError(
      new BodyDigestUnavailable({ reason: 'crypto.subtle is unavailable' })
    )
    expect(ParseResult.TreeFormatter.formatErrorSync(error)).toContain(
      'crypto.subtle is unavailable'
    )
  })

  it('lands in parse’s error channel rather than dying, so one exchange fails and the run drains', async () => {
    // The tracker runs `parse` under `Effect.either`, so a typed failure costs
    // this one exchange; a defect would take the run with it.
    const failing = digestFailureAsParseError(new BodyDigestUnavailable({ reason: 'nope' }))
    expectRightToEqual(
      Effect.runSync(Effect.either(Effect.either(Effect.fail(failing)))),
      Either.left(failing)
    )
  })
})
