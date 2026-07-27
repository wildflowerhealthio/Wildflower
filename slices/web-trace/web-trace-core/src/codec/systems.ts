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
 * Base for every web-trace extension URL, including the nested ones.
 *
 * @remarks
 * FHIR permits a bare token for a sub-extension's `url`, but this encoding
 * spells every extension — nested included — as an absolute URL under this
 * base. A token like `name` is only meaningful relative to a parent nobody
 * carries around; a URL identifies the same thing wherever it is quoted, in a
 * search expression, a bug report, or a `StructureDefinition` we may later
 * serve.
 */
const WEB_TRACE_EXTENSION_BASE = `${WEB_TRACE_BASE}/StructureDefinition` as const

/**
 * Resource-level extension holding the response status line.
 *
 * @remarks
 * `DocumentReference.description` renders the status for a human, but parsing it
 * back is fragile — the status code and text ride here so the codec round-trips
 * losslessly. Sub-extensions: {@link RESPONSE_STATUS_CODE_EXTENSION} and
 * {@link RESPONSE_STATUS_TEXT_EXTENSION}.
 */
const RESPONSE_STATUS_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-status` as const

/** Sub-extension of {@link RESPONSE_STATUS_EXTENSION}: the status code (`valueInteger`). */
const RESPONSE_STATUS_CODE_EXTENSION =
  `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-status-code` as const

/** Sub-extension of {@link RESPONSE_STATUS_EXTENSION}: the reason phrase (`valueString`). */
const RESPONSE_STATUS_TEXT_EXTENSION =
  `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-status-text` as const

/**
 * Content-level extension holding the response headers as ordered pairs.
 *
 * @remarks
 * One {@link RESPONSE_HEADER_EXTENSION} repetition per header, in capture order.
 * Repeats of the same header name (`Set-Cookie`) survive, which a
 * `Record<string, string>` would collapse.
 */
const RESPONSE_HEADERS_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-headers` as const

/** Sub-extension of {@link RESPONSE_HEADERS_EXTENSION}: one header, name and value. */
const RESPONSE_HEADER_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-header` as const

/** Sub-extension of {@link RESPONSE_HEADER_EXTENSION}: the field name (`valueString`). */
const RESPONSE_HEADER_NAME_EXTENSION =
  `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-header-name` as const

/** Sub-extension of {@link RESPONSE_HEADER_EXTENSION}: the field value (`valueString`). */
const RESPONSE_HEADER_VALUE_EXTENSION =
  `${WEB_TRACE_EXTENSION_BASE}/web-trace-response-header-value` as const

/**
 * Content-level extension holding the observed timings.
 *
 * @remarks
 * Sub-extensions {@link TIMING_WAIT_EXTENSION} / {@link TIMING_RECEIVE_EXTENSION},
 * each a `valueDuration` and each present only when the capture observed it. An
 * absent sub-extension is "not measured", which the HAR emitter renders as `-1`.
 */
const RESPONSE_TIMINGS_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-timings` as const

/** Sub-extension of {@link RESPONSE_TIMINGS_EXTENSION}: time to first byte (`valueDuration`). */
const TIMING_WAIT_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-timing-wait` as const

/** Sub-extension of {@link RESPONSE_TIMINGS_EXTENSION}: time spent reading the body (`valueDuration`). */
const TIMING_RECEIVE_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-timing-receive` as const

/**
 * UCUM, the system a FHIR `Duration` states its unit in.
 *
 * @remarks
 * A `Duration` with a value must carry a UCUM code (invariant `drt-1`), so the
 * timing sub-extensions write `system`/`code` as well as the human-facing
 * `unit`.
 */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** UCUM code — and display unit — for a millisecond. */
const UCUM_MILLISECOND_CODE = 'ms'

/**
 * Content-level extension naming why a body was not stored (`valueString`).
 *
 * @remarks
 * Present exactly when the attachment carries `size`/`hash` but no `data`. Its
 * presence is what distinguishes a policy-skipped body from a genuinely empty
 * one.
 */
const BODY_SKIPPED_REASON_EXTENSION = `${WEB_TRACE_EXTENSION_BASE}/web-trace-body-skipped` as const

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
}
