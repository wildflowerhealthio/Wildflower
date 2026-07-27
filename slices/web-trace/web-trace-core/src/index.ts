/**
 * The pure core of the web-trace slice: the vocabulary of a recorded browsing
 * session.
 *
 * @remarks
 * `web-trace-core` sits below both a collector and a React app, which is why it
 * lives here rather than in `collector-fundamentals` (deliberately FHIR-agnostic)
 * or `browser-sniffer` (deliberately FHIR-ignorant).
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
