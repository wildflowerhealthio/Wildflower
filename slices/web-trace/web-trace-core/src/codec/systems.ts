/**
 * The private FHIR systems and extension URLs the web-trace encoding uses.
 *
 * @remarks
 * These are Wildflower-private: no public code system defines "an HTTP exchange
 * recorded from a browsing session". They are stable identifiers, not resolvable
 * documents — nothing is served at these URLs today.
 *
 * Every value here is part of the persisted wire format. Changing one orphans
 * already-recorded sessions, so treat this file as append-mostly.
 */

/** Base for every web-trace system and extension URL. */
const WEB_TRACE_BASE = 'https://wildflowerhealth.io/fhir'

/** Code system for `DocumentReference.type` and `.category` codings. */
const WEB_TRACE_CODE_SYSTEM = `${WEB_TRACE_BASE}/CodeSystem/web-trace` as const

/** `DocumentReference.type` code — this resource is one recorded HTTP exchange. */
const WEB_REQUEST_TRACE_CODE = 'web-request-trace'

/**
 * `DocumentReference.category` code — the axis the viewer filters on, and the
 * axis a clinical browser excludes.
 */
const WEB_TRACE_CATEGORY_CODE = 'web-trace'

/** Code system for the `securityLabel` marking a trace's redaction state. */
const WEB_TRACE_REDACTION_SYSTEM = `${WEB_TRACE_BASE}/CodeSystem/web-trace-redaction` as const

/**
 * `securityLabel` code — the stored exchange is raw, exactly as captured.
 *
 * @remarks
 * Capture is lossless by design and redaction happens only at the export
 * boundary, so every persisted trace carries this marker. A resource without it
 * did not come from this codec.
 */
const WEB_TRACE_RAW_CODE = 'raw'

/** Identifier system carrying the recording session's id. */
const WEB_TRACE_SESSION_IDENTIFIER_SYSTEM = `${WEB_TRACE_BASE}/sid/web-trace-session` as const

/** Identifier system carrying the sniffer's per-request correlation id. */
const WEB_TRACE_REQUEST_IDENTIFIER_SYSTEM = `${WEB_TRACE_BASE}/sid/web-trace-request` as const

/**
 * Resource-level extension holding the response status line.
 *
 * @remarks
 * `DocumentReference.description` renders the status for a human, but parsing it
 * back is fragile — the status code and text ride here so the codec round-trips
 * losslessly. Sub-extensions: `code` (`valueInteger`), `text` (`valueString`).
 */
const RESPONSE_STATUS_EXTENSION = `${WEB_TRACE_BASE}/StructureDefinition/web-trace-response-status`

/**
 * Content-level extension holding the response headers as ordered pairs.
 *
 * @remarks
 * One repetition per header, in capture order, each with `name`/`value`
 * (`valueString`) sub-extensions. Repeats of the same header name (`Set-Cookie`)
 * survive, which a `Record<string, string>` would collapse.
 */
const RESPONSE_HEADERS_EXTENSION = `${WEB_TRACE_BASE}/StructureDefinition/web-trace-response-headers`

/**
 * Content-level extension holding observed timings in milliseconds.
 *
 * @remarks
 * Sub-extensions `waitMs` / `receiveMs` (`valueDecimal`), each present only when
 * the capture observed it. An absent sub-extension is "not measured", which the
 * HAR emitter renders as `-1`.
 */
const RESPONSE_TIMINGS_EXTENSION = `${WEB_TRACE_BASE}/StructureDefinition/web-trace-timings`

/**
 * Content-level extension naming why a body was not stored (`valueString`).
 *
 * @remarks
 * Present exactly when the attachment carries `size`/`hash` but no `data`. Its
 * presence is what distinguishes a policy-skipped body from a genuinely empty
 * one.
 */
const BODY_SKIPPED_REASON_EXTENSION = `${WEB_TRACE_BASE}/StructureDefinition/web-trace-body-skipped`

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
}
