import { HeadersWire, ResponseStartMessageBody, SnifferRequestId } from 'browser-sniffer-core'
import { Schema } from 'effect'

/**
 * The vocabulary of a web trace: one recorded HTTP exchange, plus the
 * body/timing shapes it carries. Every other module in this package is a
 * translation to or from {@link TraceExchange} — the codec to FHIR, the
 * pseudonymizer to a redacted `TraceExchange`, the emitter to HAR.
 *
 * Field types for the sniffer-observed half (`requestId`, `url`, `status`,
 * `statusText`, `headers`) are taken from `browser-sniffer-core`'s
 * `ResponseStart` wire schema rather than restated, so a change to what the
 * sniffer reports is a type error here rather than silent drift.
 *
 * There is no request method, no request headers, and no request body: the
 * sniffer does not report them today. See the epic's "Known limitation".
 */

/**
 * Identifies one recording session. Shared by every exchange captured in that
 * session and carried into the FHIR resource as an `identifier` — session
 * identity is a shared value, not a join to a parent resource.
 */
const TraceSessionId = Schema.NonEmptyString.annotations({
  identifier: 'TraceSessionId',
  description: 'Correlates every exchange recorded in one browsing session.',
})

/**
 * A response body that was captured in full.
 *
 * @remarks
 * `data` is base64 of the raw response bytes; `size` is the length of those
 * bytes (not of the base64); `hash` is the base64-encoded SHA-256 digest of
 * them, matching FHIR's `Attachment.hash` (a `base64Binary`). The hash is
 * supplied by the capture side, so this package never needs to see the bytes.
 */
const StoredBody = Schema.TaggedStruct('StoredBody', {
  contentType: Schema.String,
  data: Schema.String,
  size: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  hash: Schema.String,
})

/**
 * A response body the capture policy declined to store, recorded so the trace
 * says what it dropped.
 *
 * @remarks
 * Carries the same `size` and `hash` a {@link StoredBody} would, and a
 * human-readable `reason` (an over-cap size, a content type outside the
 * allowlist). A trace is explicit about what it dropped; it is never silently
 * lossy.
 */
const SkippedBody = Schema.TaggedStruct('SkippedBody', {
  contentType: Schema.String,
  size: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  hash: Schema.String,
  reason: Schema.String,
})

/** A captured body ({@link StoredBody}) or a recorded omission ({@link SkippedBody}). */
const TraceBody = Schema.Union(StoredBody, SkippedBody)

/**
 * One observed timing: a `Duration` in app, a non-negative finite count of
 * milliseconds on the wire.
 *
 * @remarks
 * `Schema.DurationFromMillis` alone would be wrong here. It is built on
 * `NonNegative`, which admits `+Infinity`, and `JSON.stringify(Infinity)` is
 * `null` — the very value this schema uses for "not measured". An infinite
 * duration would therefore survive a JSON round-trip as a plausible-looking
 * absence. Composing `Schema.JsonNumber` in front rejects it in both
 * directions, along with `NaN`.
 */
const DurationFromJsonNumberMillis = Schema.compose(
  Schema.JsonNumber.pipe(Schema.greaterThanOrEqualTo(0)),
  Schema.DurationFromMillis
).annotations({
  identifier: 'DurationFromJsonNumberMillis',
  description: 'A measured elapsed time, carried on the wire as milliseconds.',
})

/**
 * The response-side timings the capture could observe.
 *
 * @remarks
 * Decoded, both are `Duration`s: nothing downstream has to remember whether a
 * bare number was seconds or milliseconds. Encoded, both are millisecond
 * numbers under the `waitMs` / `receiveMs` keys — the wire has no type to carry
 * the unit, so the key carries it.
 *
 * Both are nullable because the sniffer reports neither on its own — a capture
 * that measures them supplies them, and one that doesn't leaves them `null`,
 * which the HAR emitter turns into the spec's `-1`. `Duration.zero` is a
 * measurement of zero, not an absence. There is no `send` timing at all:
 * nothing observes the request side.
 */
const TraceTimings = Schema.Struct({
  wait: Schema.NullOr(DurationFromJsonNumberMillis).pipe(
    Schema.propertySignature,
    Schema.fromKey('waitMs')
  ),
  receive: Schema.NullOr(DurationFromJsonNumberMillis).pipe(
    Schema.propertySignature,
    Schema.fromKey('receiveMs')
  ),
})

/** A {@link TraceTimings} with nothing observed. */
const noTimings: typeof TraceTimings.Type = { wait: null, receive: null }

/**
 * One recorded HTTP exchange — the unit of storage, redaction, and export.
 *
 * @remarks
 * `startedAt` is the response start, the only instant the sniffer observes.
 * `requestId` is the sniffer's own per-request correlation key, which makes
 * `{sessionId}-{requestId}` a deterministic resource id: retried writes are
 * idempotent upserts and two sessions cannot collide.
 */
const TraceExchange = Schema.Struct({
  sessionId: TraceSessionId,
  requestId: SnifferRequestId,
  url: ResponseStartMessageBody.fields.url,
  status: ResponseStartMessageBody.fields.status,
  statusText: ResponseStartMessageBody.fields.statusText,
  headers: HeadersWire,
  startedAt: Schema.DateTimeUtc,
  timings: TraceTimings,
  body: TraceBody,
})

type TraceExchange = typeof TraceExchange.Type
type TraceBody = typeof TraceBody.Type
type StoredBody = typeof StoredBody.Type
type SkippedBody = typeof SkippedBody.Type
type TraceTimings = typeof TraceTimings.Type
type TraceSessionId = typeof TraceSessionId.Type

/**
 * The deterministic FHIR resource id for an exchange: `{sessionId}-{requestId}`.
 *
 * @param exchange - The exchange whose resource id is wanted
 * @returns The id the codec writes to `DocumentReference.id`
 */
const traceResourceId = (exchange: Pick<TraceExchange, 'sessionId' | 'requestId'>): string =>
  `${exchange.sessionId}-${exchange.requestId}`

export {
  noTimings,
  SkippedBody,
  StoredBody,
  TraceBody,
  TraceExchange,
  traceResourceId,
  TraceSessionId,
  TraceTimings,
}
