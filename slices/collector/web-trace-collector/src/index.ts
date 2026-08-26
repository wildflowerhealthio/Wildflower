// The web-trace collector: a development-purposes recorder. Point it at a URL,
// browse the portal by hand, close the window, and every XHR/fetch those pages
// fired is on device as a FHIR `DocumentReference`.
//
// Everything the registry and the React adapter need is exported from here: the
// `WebTraceCollectorDescriptor` (config, hand-driven scraping plan, persist
// sink, display) `collector-registry` assembles, the catch-all
// `RawExchangeResponseKind` factory that claims every response, the capture-time body
// policy, and the `WebTraceConfigForm` `collector-react` registers.
//
// The FHIR encoding itself lives in `web-trace-core` and is imported, never
// re-derived here — see the package AGENTS.md.

export * from './body-policy.ts'
export * from './config.ts'
export * from './response-kinds/raw-exchange-response-kind.ts'
export * from './web-trace-config-form.tsx'
