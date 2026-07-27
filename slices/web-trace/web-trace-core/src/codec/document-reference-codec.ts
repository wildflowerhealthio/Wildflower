import { DateTime, type Duration, Effect, ParseResult, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import type { TraceTimings } from '../trace-exchange.ts'
import { TraceExchange, traceResourceId } from '../trace-exchange.ts'
import { DurationFromFhirDuration } from './fhir-duration.ts'
import {
  BODY_SKIPPED_REASON_EXTENSION,
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
  WEB_REQUEST_TRACE_CODE,
  WEB_TRACE_CATEGORY_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
  WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM,
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
} from './systems.ts'

/**
 * The single definition of how a {@link TraceExchange} is encoded as a FHIR R4
 * `DocumentReference`, and how one is read back — one schema, plus the two
 * directions derived from it.
 *
 * @packageDocumentation
 */

type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * The exchange minus its timings.
 *
 * @remarks
 * Timings are the one field the decode does not read off the wire form:
 * {@link readTimings} produces `Duration`s directly, from the units the FHIR
 * `Duration`s state. Omitting the field here is what lets those `Duration`s be
 * handed over as-is rather than converted back to milliseconds for
 * `TraceExchange` to convert forward again.
 */
const TraceExchangeWithoutTimings = TraceExchange.omit('timings')

// The `ParseResult.*` variants (rather than `Schema.*`) fail with a bare
// `ParseIssue`, which is what a `transformOrFail` step has to return — so an
// inner failure keeps its structure instead of being flattened into a string.
const decodeResource = ParseResult.decodeUnknown(DocumentReference.Schema)
const encodeResource = ParseResult.encode(DocumentReference.Schema)
const decodeExchangeWithoutTimings = ParseResult.decodeUnknown(TraceExchangeWithoutTimings)
const decodeDuration = ParseResult.decodeUnknown(DurationFromFhirDuration)
const encodeDuration = Schema.encodeSync(DurationFromFhirDuration)

/** A `valueString` sub-extension; the shape most leaf extensions here use. */
const stringExtension = (url: string, value: string): FhirR4.Extension => ({
  url,
  valueString: value,
})

/** A `valueDuration` sub-extension. {@link DurationFromFhirDuration} owns the units. */
const durationExtension = (url: string, duration: Duration.Duration): FhirR4.Extension => ({
  url,
  valueDuration: encodeDuration(duration),
})

/**
 * Human-readable one-liner for `DocumentReference.description`, e.g.
 * `https://portal.example/api/patients?q=… → 200`.
 */
const describeExchange = (exchange: TraceExchange): string => `${exchange.url} → ${exchange.status}`

const headersExtension = (exchange: TraceExchange): FhirR4.Extension => ({
  url: RESPONSE_HEADERS_EXTENSION,
  extension: exchange.headers.map(([name, value]) => ({
    url: RESPONSE_HEADER_EXTENSION,
    extension: [
      stringExtension(RESPONSE_HEADER_NAME_EXTENSION, name),
      stringExtension(RESPONSE_HEADER_VALUE_EXTENSION, value),
    ],
  })),
})

const timingsExtension = (exchange: TraceExchange): readonly FhirR4.Extension[] => {
  const { wait, receive } = exchange.timings
  if (wait === null && receive === null) return []
  return [
    {
      url: RESPONSE_TIMINGS_EXTENSION,
      extension: [
        ...(wait === null ? [] : [durationExtension(TIMING_WAIT_EXTENSION, wait)]),
        ...(receive === null ? [] : [durationExtension(TIMING_RECEIVE_EXTENSION, receive)]),
      ],
    },
  ]
}

const contentEntry = (exchange: TraceExchange): FhirR4.DocumentReferenceContent => ({
  extension: [
    headersExtension(exchange),
    ...timingsExtension(exchange),
    ...(exchange.body._tag === 'SkippedBody'
      ? [stringExtension(BODY_SKIPPED_REASON_EXTENSION, exchange.body.reason)]
      : []),
  ],
  attachment: {
    contentType: exchange.body.contentType,
    // A skipped body is exactly "size and hash, no data" — the absence of
    // `data` alongside the skipped-reason extension is what marks it.
    ...(exchange.body._tag === 'StoredBody' ? { data: exchange.body.data } : {}),
    size: exchange.body.size,
    hash: exchange.body.hash,
    title: exchange.url,
  },
})

/**
 * Encodes one recorded exchange as the FHIR R4 `DocumentReference` wire object.
 *
 * @param exchange - The exchange to encode
 * @returns The wire-format resource, ready to decode or to write
 *
 * @remarks
 * `subject` is deliberately absent: traces are engineering artifacts that happen
 * to contain PHI, and leaving `subject` unset keeps them out of
 * `Patient/$everything` and out of clinical exports. They stay reachable by
 * `category` search.
 */
const traceExchangeToWire = (exchange: TraceExchange): FhirR4.DocumentReference => ({
  resourceType: 'DocumentReference',
  id: traceResourceId(exchange),
  status: 'current',
  extension: [
    {
      url: RESPONSE_STATUS_EXTENSION,
      extension: [
        { url: RESPONSE_STATUS_CODE_EXTENSION, valueInteger: exchange.status },
        stringExtension(RESPONSE_STATUS_TEXT_EXTENSION, exchange.statusText),
      ],
    },
  ],
  identifier: [
    { system: WEB_TRACE_SESSION_IDENTIFIER_SYSTEM, value: exchange.sessionId },
    { system: WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM, value: exchange.requestId },
  ],
  type: { coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: WEB_REQUEST_TRACE_CODE }] },
  category: [{ coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: WEB_TRACE_CATEGORY_CODE }] }],
  date: DateTime.formatIso(exchange.startedAt),
  description: describeExchange(exchange),
  securityLabel: [{ coding: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }] }],
  content: [contentEntry(exchange)],
})

/** Finds the first extension with `url`, at whatever level it was handed. */
const findExtension = (
  extensions: readonly FhirR4.Extension[] | undefined,
  url: string
): FhirR4.Extension | undefined => extensions?.find((extension) => extension.url === url)

const identifierValue = (resource: FhirR4.DocumentReference, system: string): string | undefined =>
  resource.identifier?.find((identifier) => identifier.system === system)?.value

const readHeaders = (
  content: FhirR4.DocumentReferenceContent
): readonly (readonly [string, string])[] =>
  (findExtension(content.extension, RESPONSE_HEADERS_EXTENSION)?.extension ?? []).flatMap(
    (header) => {
      const name = findExtension(header.extension, RESPONSE_HEADER_NAME_EXTENSION)?.valueString
      const value = findExtension(header.extension, RESPONSE_HEADER_VALUE_EXTENSION)?.valueString
      return name === undefined || value === undefined ? [] : [[name, value] as const]
    }
  )

/**
 * Reads one timing sub-extension as a `Duration`, or `null` if it is absent.
 *
 * @remarks
 * An absent sub-extension is "not measured". A present one is *parsed*, not
 * read: {@link DurationFromFhirDuration} interprets the UCUM code the resource
 * states, so a duration written in seconds decodes to a second-sized
 * `Duration`, and one whose unit cannot be converted fails instead of passing
 * for milliseconds.
 */
const readDuration = (
  timings: readonly FhirR4.Extension[] | undefined,
  url: string
): Effect.Effect<Duration.Duration | null, ParseResult.ParseIssue> => {
  const quantity = findExtension(timings, url)?.valueDuration
  return quantity === undefined ? Effect.succeed(null) : decodeDuration(quantity)
}

/**
 * Reads the observed timings, decoded — `Duration`s, not milliseconds.
 *
 * @remarks
 * This is the one part of a resource the codec decodes itself rather than
 * handing to `TraceExchange`, because the wire form carries its own unit and
 * `TraceTimings` does not: `waitMs` means milliseconds by name, while a FHIR
 * `Duration` means whatever its `code` says. Parsing here and omitting
 * `timings` from {@link TraceExchangeWithoutTimings} keeps the two facts from
 * having to agree.
 */
const readTimings = (
  content: FhirR4.DocumentReferenceContent
): Effect.Effect<typeof TraceTimings.Type, ParseResult.ParseIssue> => {
  const timings = findExtension(content.extension, RESPONSE_TIMINGS_EXTENSION)?.extension
  return Effect.all({
    wait: readDuration(timings, TIMING_WAIT_EXTENSION),
    receive: readDuration(timings, TIMING_RECEIVE_EXTENSION),
  })
}

const readBody = (content: FhirR4.DocumentReferenceContent): Record<string, unknown> => {
  const attachment = content.attachment
  const skippedReason = findExtension(content.extension, BODY_SKIPPED_REASON_EXTENSION)?.valueString
  const common = {
    contentType: attachment.contentType,
    size: attachment.size,
    hash: attachment.hash,
  }
  return skippedReason === undefined
    ? { _tag: 'StoredBody', ...common, data: attachment.data }
    : { _tag: 'SkippedBody', ...common, reason: skippedReason }
}

/**
 * Reads the exchange — minus its timings — out of a `DocumentReference` wire
 * object, or names the first thing the encoding requires and the resource does
 * not carry.
 *
 * @remarks
 * Returns the *encoded* form for {@link TraceExchangeWithoutTimings} to decode,
 * so a wire value of the wrong type fails as a `ParseIssue` against the schema
 * rather than as a hand-written check here. Timings are the exception and come
 * from {@link readTimings}, which is why the content entry is handed back
 * alongside.
 */
const readEncodedExchange = (
  wire: FhirR4.DocumentReference
):
  | {
      readonly ok: true
      readonly value: unknown
      readonly content: FhirR4.DocumentReferenceContent
    }
  | { readonly ok: false; readonly reason: string } => {
  const content = wire.content?.[0]
  if (content === undefined) return { ok: false, reason: 'No content entry' }

  const status = findExtension(wire.extension, RESPONSE_STATUS_EXTENSION)?.extension
  const statusCode = findExtension(status, RESPONSE_STATUS_CODE_EXTENSION)?.valueInteger
  const statusText = findExtension(status, RESPONSE_STATUS_TEXT_EXTENSION)?.valueString
  if (statusCode === undefined || statusText === undefined) {
    return { ok: false, reason: `Missing ${RESPONSE_STATUS_EXTENSION}` }
  }

  const sessionId = identifierValue(wire, WEB_TRACE_SESSION_IDENTIFIER_SYSTEM)
  const requestId = identifierValue(wire, WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM)
  if (sessionId === undefined || requestId === undefined) {
    return { ok: false, reason: 'Missing session or request identifier' }
  }

  return {
    ok: true,
    content,
    value: {
      sessionId,
      requestId,
      url: content.attachment.title,
      status: statusCode,
      statusText,
      headers: readHeaders(content),
      startedAt: wire.date,
      body: readBody(content),
    },
  }
}

/**
 * The encoding, as one schema: a decoded FHIR R4 `DocumentReference` on the
 * encoded side, a {@link TraceExchange} on the decoded side.
 *
 * @remarks
 * This is the single definition — {@link toDocumentReference} and
 * {@link fromDocumentReference} are `Schema.encode` / `Schema.decode` of it, and
 * a second implementation of the encoding is a defect, not an optimization.
 *
 * Both directions fail the way any schema does, with a `ParseError`: a resource
 * that is missing the status extension, the trace identifiers, or a content
 * entry raises a `ParseResult.Type` issue naming what was missing; anything
 * present but ill-typed fails against `TraceExchange` itself rather than against
 * a hand-written check; and a timing in a unit that cannot be converted fails
 * against {@link DurationFromFhirDuration}. Compose it, refine it, or put it in
 * a struct like any other schema.
 */
const TraceExchangeFromDocumentReference: Schema.Schema<TraceExchange, DocumentReferenceType> =
  Schema.transformOrFail(
    Schema.typeSchema(DocumentReference.Schema),
    Schema.typeSchema(TraceExchange),
    {
      strict: true,
      decode: (resource, _options, ast) =>
        encodeResource(resource).pipe(
          Effect.flatMap((wire) => {
            const read = readEncodedExchange(wire)
            return read.ok
              ? Effect.all({
                  exchange: decodeExchangeWithoutTimings(read.value),
                  timings: readTimings(read.content),
                }).pipe(Effect.map(({ exchange, timings }) => ({ ...exchange, timings })))
              : Effect.fail(
                  new ParseResult.Type(ast, resource, `${wire.id ?? '<no id>'}: ${read.reason}`)
                )
          })
        ),
      encode: (exchange) => decodeResource(traceExchangeToWire(exchange)),
    }
  ).annotations({
    identifier: 'TraceExchangeFromDocumentReference',
    description: 'One recorded HTTP exchange, encoded as a FHIR R4 DocumentReference.',
  })

/**
 * The same encoding, reading from raw FHIR JSON.
 *
 * @remarks
 * {@link TraceExchangeFromDocumentReference} starts from a resource that has
 * already been decoded; this one starts from what a FHIR server actually sends,
 * so `Schema.decodeUnknown` on a response body reaches a `TraceExchange` in one
 * step and `Schema.encode` produces a body ready to `PUT`.
 */
const TraceExchangeFromFhirJson: Schema.Schema<TraceExchange, FhirR4.DocumentReference> =
  Schema.compose(DocumentReference.Schema, TraceExchangeFromDocumentReference).annotations({
    identifier: 'TraceExchangeFromFhirJson',
    description: 'One recorded HTTP exchange, encoded as FHIR R4 DocumentReference JSON.',
  })

/**
 * Encodes one recorded exchange as a decoded FHIR R4 `DocumentReference`.
 *
 * @remarks
 * `Schema.encode` of {@link TraceExchangeFromDocumentReference}, named for the
 * direction callers read it in. Fails only if the encoding itself is malformed —
 * a `ParseError` here means this module and `fhir-r4`'s `DocumentReference`
 * schema have diverged, not that the caller supplied bad data.
 */
const toDocumentReference = Schema.encode(TraceExchangeFromDocumentReference)

/**
 * Reads a decoded `DocumentReference` back as the exchange it encodes.
 *
 * @remarks
 * `Schema.decode` of {@link TraceExchangeFromDocumentReference}, the inverse of
 * {@link toDocumentReference}; the two are tested as such. A `ParseError` names
 * what was missing. Anything the encoding does not put on the resource — a
 * request method, request headers — is absent here too rather than guessed.
 */
const fromDocumentReference = Schema.decode(TraceExchangeFromDocumentReference)

/**
 * Whether a decoded `DocumentReference` is a web trace, by `category`.
 *
 * @param resource - Any decoded `DocumentReference`
 * @returns `true` when the resource carries the web-trace category coding
 *
 * @remarks
 * `category` is the axis the viewer filters on and the axis a clinical browser
 * excludes, so this predicate is the one place that decision is spelled out.
 */
const isWebTrace = (resource: DocumentReferenceType): boolean =>
  resource.category.some((category) =>
    category.coding.some(
      (coding) =>
        coding.system?.toString() === WEB_TRACE_CODE_SYSTEM &&
        coding.code === WEB_TRACE_CATEGORY_CODE
    )
  )

export {
  type DocumentReferenceType,
  fromDocumentReference,
  isWebTrace,
  toDocumentReference,
  TraceExchangeFromDocumentReference,
  TraceExchangeFromFhirJson,
  traceExchangeToWire,
}
