// The web-trace collector: a development-purposes recorder. Point it at a URL,
// browse the portal by hand, close the window, and every XHR/fetch those pages
// fired is on device as a FHIR `DocumentReference`.
//
// Everything the registry and the React adapter need is exported from here: the
// `WebTraceCollectorDescriptor` (config, hand-driven scraping plan, persist
// sink, display) `collector-registry` assembles, and the `WebTraceConfigForm`
// `collector-react` registers. The catch-all `RawExchangeResponseKind` factory
// and the capture-time body policy now live in `web-trace-source`.

export * from './config.ts'
export * from './web-trace-config-form.tsx'
