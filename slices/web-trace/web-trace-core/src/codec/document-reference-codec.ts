import { Data, DateTime, Effect, Schema } from 'effect'
import { DocumentReference } from 'fhir-r4/resources'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { TraceExchange, traceResourceId, TraceTimings } from '../trace-exchange.ts'
import {
  BODY_SKIPPED_REASON_EXTENSION,
  RESPONSE_HEADERS_EXTENSION,
  RESPONSE_STATUS_EXTENSION,
  RESPONSE_TIMINGS_EXTENSION,
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
 * `DocumentReference`, and how one is read back.
 *
 * @packageDocumentation
 */

type DocumentReferenceType = typeof DocumentReference.Schema.Type

/**
 * Raised when a `DocumentReference` cannot be read as a trace exchange —
 * it is missing the session/request identifiers, the status extension, or the
 * content entry the encoding requires.
 *
 * @remarks
 * `resourceId` is the offending resource's `id` when it has one, so a failure
 * inside a page of search results names which resource failed.
 */
class TraceDecodeError extends Data.TaggedError('TraceDecodeError')<{
  readonly reason: string
  readonly resourceId: string | null
}> {}

const decodeResource = Schema.decodeUnknown(DocumentReference.Schema)
const encodeResource = Schema.encode(DocumentReference.Schema)
const decodeExchange = Schema.decodeUnknown(TraceExchange)

/** A `valueString` sub-extension; the shape every leaf extension here uses. */
const stringExtension = (url: string, value: string): FhirR4.Extension => ({
  url,
  valueString: value,
})

/**
 * Human-readable one-liner for `DocumentReference.description`, e.g.
 * `https://portal.example/api/patients?q=… → 200`.
 */
const describeExchange = (exchange: TraceExchange): string => `${exchange.url} → ${exchange.status}`

const headersExtension = (exchange: TraceExchange): FhirR4.Extension => ({
  url: RESPONSE_HEADERS_EXTENSION,
  extension: exchange.headers.map(([name, value]) => ({
    url: 'header',
    extension: [stringExtension('name', name), stringExtension('value', value)],
  })),
})

/**
 * Timings are `Duration`s in app and milliseconds on the wire, and the schema
 * is the one place that conversion is defined — the FHIR `valueDecimal`s take
 * the encoded form rather than restating `Duration.toMillis`.
 */
const encodeTimings = Schema.encodeSync(TraceTimings)

const timingsExtension = (exchange: TraceExchange): readonly FhirR4.Extension[] => {
  const { waitMs, receiveMs } = encodeTimings(exchange.timings)
  if (waitMs === null && receiveMs === null) return []
  return [
    {
      url: RESPONSE_TIMINGS_EXTENSION,
      extension: [
        ...(waitMs === null ? [] : [{ url: 'waitMs', valueDecimal: waitMs }]),
        ...(receiveMs === null ? [] : [{ url: 'receiveMs', valueDecimal: receiveMs }]),
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
        { url: 'code', valueInteger: exchange.status },
        stringExtension('text', exchange.statusText),
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

/**
 * Encodes one recorded exchange as a decoded FHIR R4 `DocumentReference`.
 *
 * @param exchange - The exchange to encode
 * @returns The resource, in the decoded form the rest of the codebase passes around
 *
 * @remarks
 * Fails only if the encoding itself is malformed — a `ParseError` here means
 * this module and `fhir-r4`'s `DocumentReference` schema have diverged, not that
 * the caller supplied bad data.
 */
const toDocumentReference = (
  exchange: TraceExchange
): Effect.Effect<DocumentReferenceType, TraceDecodeError> =>
  decodeResource(traceExchangeToWire(exchange)).pipe(
    Effect.mapError(
      (cause) =>
        new TraceDecodeError({
          reason: `Encoded trace is not a valid DocumentReference: ${cause.message}`,
          resourceId: traceResourceId(exchange),
        })
    )
  )

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
      const name = findExtension(header.extension, 'name')?.valueString
      const value = findExtension(header.extension, 'value')?.valueString
      return name === undefined || value === undefined ? [] : [[name, value] as const]
    }
  )

// The result feeds `decodeExchange`, so this reads the *encoded* timings —
// milliseconds, not `Duration`s. Typing it as `TraceTimings.Encoded` keeps it
// that way if the wire form ever changes.
const readTimings = (content: FhirR4.DocumentReferenceContent): typeof TraceTimings.Encoded => {
  const timings = findExtension(content.extension, RESPONSE_TIMINGS_EXTENSION)?.extension
  return {
    waitMs: findExtension(timings, 'waitMs')?.valueDecimal ?? null,
    receiveMs: findExtension(timings, 'receiveMs')?.valueDecimal ?? null,
  }
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
 * Reads a decoded `DocumentReference` back as the exchange it encodes.
 *
 * @param resource - A resource produced by {@link toDocumentReference}
 * @returns The exchange, or a {@link TraceDecodeError} naming what was missing
 *
 * @remarks
 * This is the inverse of {@link toDocumentReference} and the two are tested as
 * such. Anything the encoding does not put on the resource — a request method,
 * request headers — is absent here too rather than guessed.
 */
const fromDocumentReference = (
  resource: DocumentReferenceType
): Effect.Effect<TraceExchange, TraceDecodeError> =>
  Effect.gen(function* () {
    const wire = yield* encodeResource(resource).pipe(
      Effect.mapError(
        (cause) =>
          new TraceDecodeError({
            reason: `Resource does not encode to FHIR wire format: ${cause.message}`,
            resourceId: resource.id,
          })
      )
    )
    const fail = (reason: string): TraceDecodeError =>
      new TraceDecodeError({ reason, resourceId: wire.id ?? null })

    const content = wire.content[0]
    if (content === undefined) return yield* Effect.fail(fail('No content entry'))

    const status = findExtension(wire.extension, RESPONSE_STATUS_EXTENSION)?.extension
    const statusCode = findExtension(status, 'code')?.valueInteger
    const statusText = findExtension(status, 'text')?.valueString
    if (statusCode === undefined || statusText === undefined) {
      return yield* Effect.fail(fail(`Missing ${RESPONSE_STATUS_EXTENSION}`))
    }

    const sessionId = identifierValue(wire, WEB_TRACE_SESSION_IDENTIFIER_SYSTEM)
    const requestId = identifierValue(wire, WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM)
    if (sessionId === undefined || requestId === undefined) {
      return yield* Effect.fail(fail('Missing session or request identifier'))
    }

    return yield* decodeExchange({
      sessionId,
      requestId,
      url: content.attachment.title,
      status: statusCode,
      statusText,
      headers: readHeaders(content),
      startedAt: wire.date,
      timings: readTimings(content),
      body: readBody(content),
    }).pipe(Effect.mapError((cause) => fail(`Not a well-formed trace: ${cause.message}`)))
  })

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
  TraceDecodeError,
  traceExchangeToWire,
}
