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
 * @packageDocumentation
 */
export {
  type DocumentReferenceType,
  fromDocumentReference,
  isWebTrace,
  toDocumentReference,
  TraceDecodeError,
  traceExchangeToWire,
} from './document-reference-codec.ts'
export {
  BODY_SKIPPED_REASON_EXTENSION,
  RESPONSE_HEADERS_EXTENSION,
  RESPONSE_STATUS_EXTENSION,
  RESPONSE_TIMINGS_EXTENSION,
  WEB_REQUEST_TRACE_CODE,
  WEB_TRACE_BASE,
  WEB_TRACE_CATEGORY_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
  WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM,
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
} from './systems.ts'
