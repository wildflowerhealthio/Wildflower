/**
 * The single definition of how a web trace is encoded as FHIR.
 *
 * @remarks
 * Anything that reads or writes trace `DocumentReference`s — the capturing
 * collector, the retrofit of the existing collectors, the viewer — imports this
 * module. A second implementation of the encoding is a defect, not an
 * optimization: the two would drift and already-recorded sessions would stop
 * decoding.
 *
 * The encoding is one schema, `TraceExchangeFromDocumentReference`;
 * `toDocumentReference` / `fromDocumentReference` are its two directions, and
 * both fail with a `ParseError` like any other schema.
 *
 * @packageDocumentation
 */
export {
  type DocumentReferenceType,
  fromDocumentReference,
  isWebTrace,
  toDocumentReference,
  TraceExchangeFromDocumentReference,
  TraceExchangeFromFhirJson,
  traceExchangeToWire,
} from './document-reference-codec.ts'
export {
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
  UCUM_MILLISECOND_CODE,
  UCUM_SYSTEM,
  WEB_REQUEST_TRACE_CODE,
  WEB_TRACE_BASE,
  WEB_TRACE_CATEGORY_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_EXTENSION_BASE,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
  WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM,
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
} from './systems.ts'
