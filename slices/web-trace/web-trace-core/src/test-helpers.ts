import { DateTime, Duration, Schema } from 'effect'
import type * as FastCheck from 'fast-check'

import { noTimings } from './trace-exchange.ts'
import type { TraceBody, TraceExchange } from './trace-exchange.ts'

/**
 * `fast-check` arbitraries for realistic captured sessions, shared by this
 * package's tests and available to the packages built on top of it.
 *
 * @remarks
 * `Arbitrary.make(TraceExchange)` would satisfy the schema while producing
 * bodies that are not base64, URLs that are not URLs, and timestamps outside the
 * representable range — none of which exercises what the codec, the
 * pseudonymizer, or the emitter actually do. These arbitraries generate captures
 * that look like captures: real URLs with identifier-bearing paths, JSON bodies,
 * cookie headers, and a mix of stored and policy-skipped bodies.
 *
 * @packageDocumentation
 */

const encodeBase64 = Schema.encodeSync(Schema.StringFromBase64)

/** Milliseconds at 2024-01-01T00:00:00Z — the floor for generated capture times. */
const CAPTURE_FLOOR = Date.UTC(2024, 0, 1)

/** One hour past {@link CAPTURE_FLOOR}; a session's worth of capture times. */
const CAPTURE_CEILING = CAPTURE_FLOOR + 60 * 60 * 1000

const HOSTS = ['portal.example.org', 'api.example.com', 'tunnel.example.ca'] as const

/**
 * Base64 of a JSON value, ready for `StoredBody.data`.
 *
 * @param value - Any JSON-serializable value
 * @returns The base64 the capture side would have stored
 */
const jsonBody = (value: unknown): string => encodeBase64(JSON.stringify(value))

/**
 * Builds a {@link TraceExchange} from a partial description, filling everything
 * unstated with a plausible default.
 *
 * @param overrides - The fields this exchange should carry
 * @returns A complete exchange
 *
 * @remarks
 * Example-based tests use this to state only what they are about — a specific
 * body, a specific header — without restating a whole capture each time.
 */
const traceExchange = (
  overrides: Partial<Omit<TraceExchange, 'startedAt'>> & { readonly startedAtMillis?: number } = {}
): TraceExchange => {
  const { startedAtMillis, ...rest } = overrides
  return {
    sessionId: 'session-0',
    requestId: 'req-0',
    url: 'https://portal.example.org/api/v2/patients',
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', 'application/json']],
    startedAt: DateTime.unsafeMake(startedAtMillis ?? CAPTURE_FLOOR),
    timings: noTimings,
    body: {
      _tag: 'StoredBody',
      contentType: 'application/json',
      data: jsonBody({}),
      size: 2,
      hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
    },
    ...rest,
  }
}

/**
 * A generator of realistic captured sessions.
 *
 * @param fc - The `fast-check` module, taken as a parameter so this file has no
 *   runtime dependency on it
 * @returns Arbitraries for the pieces of a capture and for whole exchanges
 *
 * @remarks
 * The identifier values are drawn long on purpose: a two-character value has too
 * small a pseudonym space to say anything meaningful about collisions or about
 * substring survival, and short values are not what a privacy boundary exists to
 * protect.
 */
const arbitraries = (
  fc: typeof FastCheck
): {
  readonly identifier: FastCheck.Arbitrary<string>
  readonly jsonLeaf: FastCheck.Arbitrary<string | number | boolean | null>
  readonly jsonBodyValue: FastCheck.Arbitrary<unknown>
  readonly body: FastCheck.Arbitrary<TraceBody>
  readonly exchange: FastCheck.Arbitrary<TraceExchange>
  readonly session: FastCheck.Arbitrary<readonly TraceExchange[]>
} => {
  const hexOf = (length: number): FastCheck.Arbitrary<string> =>
    fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
        minLength: length,
        maxLength: length,
      })
      .map((chars) => chars.join(''))

  const uuid = fc
    .tuple(hexOf(8), hexOf(4), hexOf(3), hexOf(3), hexOf(12))
    .map(([a, b, c, d, e]) => `${a}-${b}-4${c}-a${d}-${e}`)

  const alphanumeric = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 10,
      maxLength: 24,
    })
    .map((chars) => `A${chars.join('')}`)

  const numeric = fc.integer({ min: 100_000, max: 999_999_999 }).map(String)

  const isoDate = fc
    .integer({ min: CAPTURE_FLOOR, max: CAPTURE_CEILING })
    .map((millis) => new Date(millis).toISOString())

  const email = fc
    .tuple(
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 6,
        maxLength: 12,
      }),
      fc.constantFrom('example.org', 'example.com')
    )
    .map(([local, domain]) => `${local.join('')}@${domain}`)

  const identifier = fc.oneof(uuid, alphanumeric, numeric, isoDate, email)

  const jsonLeaf = fc.oneof(
    identifier,
    fc.integer({ min: 1, max: 10_000 }),
    fc.boolean(),
    fc.constant(null)
  )

  const jsonBodyValue = fc.letrec<{ node: unknown }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      jsonLeaf,
      fc.array(tie('node'), { maxLength: 3 }),
      fc.dictionary(
        fc.constantFrom('id', 'name', 'status', 'updatedAt', 'entry', 'resource', 'value'),
        tie('node'),
        { maxKeys: 4 }
      )
    ),
  })).node

  const body: FastCheck.Arbitrary<TraceBody> = fc.oneof(
    jsonBodyValue.map(
      (value): TraceBody => ({
        _tag: 'StoredBody',
        contentType: 'application/json',
        data: jsonBody(value),
        size: JSON.stringify(value).length,
        hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
      })
    ),
    fc.tuple(fc.constantFrom('text/html', 'image/png'), fc.integer({ min: 0, max: 1_000_000 })).map(
      ([contentType, size]): TraceBody => ({
        _tag: 'SkippedBody',
        contentType,
        size,
        hash: 'A49bTU9YfPy0AjKGWZlIY4S0RvOKrCNjHYnCTLTPQGA=',
        reason: 'Content type outside the allowlist',
      })
    )
  )

  // Whole microseconds: the resolution a capture actually measures at, and the
  // coarsest at which `Duration.millis` is canonical. Raw doubles would fail
  // the round-trip property on Duration's Millis/Nanos normalization rather
  // than on anything the schema does — see this package's AGENTS.md.
  const waitDuration = fc
    .integer({ min: 0, max: 5_000_000 })
    .map((micros) => Duration.millis(micros / 1000))

  const url = fc
    .tuple(
      fc.constantFrom(...HOSTS),
      fc.constantFrom('patients', 'observations', 'medications'),
      identifier,
      fc.option(identifier, { nil: undefined })
    )
    .map(([host, collection, id, query]) => {
      const base = `https://${host}/api/v2/${collection}/${encodeURIComponent(id)}`
      return query === undefined ? base : `${base}?q=${encodeURIComponent(query)}`
    })

  const headers = fc
    .tuple(identifier, fc.option(identifier, { nil: undefined }))
    .map(([requestId, cookie]): readonly (readonly [string, string])[] => [
      ['Content-Type', 'application/json'] as const,
      ['X-Request-Id', requestId] as const,
      ...(cookie === undefined ? [] : [['Cookie', `session=${cookie}; theme=dark`] as const]),
    ])

  const exchange: FastCheck.Arbitrary<TraceExchange> = fc
    .tuple(
      fc.integer({ min: 0, max: 999 }),
      url,
      fc.constantFrom(200, 201, 400, 404, 500),
      headers,
      fc.integer({ min: CAPTURE_FLOOR, max: CAPTURE_CEILING }),
      fc.option(waitDuration, { nil: null }),
      body
    )
    .map(([index, requestUrl, status, requestHeaders, millis, wait, requestBody]) => ({
      sessionId: 'session-2f8c',
      requestId: `req-${index}`,
      url: requestUrl,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: requestHeaders,
      startedAt: DateTime.unsafeMake(millis),
      timings: { wait, receive: null },
      body: requestBody,
    }))

  return {
    identifier,
    jsonLeaf,
    jsonBodyValue,
    body,
    exchange,
    // Request ids must be unique within a session for resource ids to be
    // unique, so the session arbitrary renumbers rather than trusting the
    // per-exchange draw.
    session: fc
      .array(exchange, { minLength: 1, maxLength: 6 })
      .map((exchanges) => exchanges.map((one, index) => ({ ...one, requestId: `req-${index}` }))),
  }
}

export { arbitraries, CAPTURE_CEILING, CAPTURE_FLOOR, jsonBody, traceExchange }
