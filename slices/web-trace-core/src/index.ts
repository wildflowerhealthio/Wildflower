/**
 * The pure core of web-trace: the vocabulary of a recorded browsing
 * session.
 *
 * @remarks
 * `web-trace-core` sits below the Recorder, the HAR format, the importer, and
 * the anonymizer, which is why it lives directly in `slices/` rather than in
 * `browser-sniffer` (deliberately FHIR-ignorant).
 *
 * @packageDocumentation
 */
export {
  noTimings,
  SkippedBody,
  StoredBody,
  TraceBody,
  TraceExchange,
  traceResourceId,
  TraceSessionId,
  TraceTimings,
} from './trace-exchange.ts'
