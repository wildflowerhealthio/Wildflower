# AGENTS.md --- collector-fundamentals

The collector vocabulary and the handler machines, built on
`http-extraction-fundamentals`. Everything else in the `collector` slice
depends on it; within the slice it depends on nothing, and outside it only on
`http-extraction-fundamentals`. Deliberately FHIR-agnostic.

## Package layout

### `src/model/`

Domain types shared across the slice:

- **`CollectorDescriptor`** --- a collector as one first-class value (config
  schema, plan factory, persist sink, display strings).
- **`ScrapingPlan`** --- the per-run plan: `stepSequence`, `responseKinds`,
  optional `captureProvenance` hook, `maxGeneratedSteps`, `drainedGuardTimeout`.
- **`Step`** --- `Navigation | Delay | AwaitPageSettled | AwaitPageRequested |
AwaitUserDismiss | EnsureWindowVisible`.
- **`CollectorHttpResponse`** --- the live, chunk-accumulating `HttpResponse`
  implementation. Exposes `bytes()` (lossless) and `text()` (UTF-8, lossy).
- **`ResourcePersistenceRuntime`** / `Context` / `Program` --- the existential
  write seam (see
  [Collector Sync Explanation](./docs/Collector%20Sync%20Explanation.md)).
- **`WebViewSource`** --- `Uri | Html` source for an `Open` action.

### `src/handler/`

The response tracker, automatic-navigation machine, run lifecycle, and their
single-surface composition. See the
[Handler Explanation](./docs/Handler%20Explanation.md).

- **`collector-bridge-message-handler.ts`** --- composes the tracker, the
  automatic-navigation machine, and the run lifecycle into the single
  `CollectorBridgeMessageHandler` record the bridge dispatches to. Owns the
  dedup + cap guards on generated steps.
- **`sniffer-response-tracker.ts`** --- the five response-event handlers
  (`ResponseStart` / `ResponseData` / `ResponseFinished` / `RequestError` /
  `Cancelled`) and the `incompleteSniffedRequests` map. The
  generate --> capture --> record --> drop --> offer ordering is enforced here.
- **`run-recorder.ts`** --- optional `RunRecorder` that captures every settled
  response (`ResponseFinished` and `RequestError`) as an `Extraction.Input`,
  minus omitted content types (scripts, styles, media). Threaded through the
  handler --> tracker composition mirroring the `captureProvenance` pattern.
  The recorder's `entries()` are suitable for offline re-extraction via
  `http-extraction-fundamentals`' `runExtraction`.
- **`run-lifecycle-state.ts`** --- owns the `requestSniffingResults` stream and
  every way a run can end.
- **`automatic-navigation/`** --- the step-queue FSM (see Handler Explanation).
- **`extraction-parity.test.ts`** --- the live-vs-offline parity pin: asserts
  that `SnifferResponseTracker` and `runExtraction` route and decode
  identically.

### `docs/`

- [Collector Sync Explanation](./docs/Collector%20Sync%20Explanation.md) ---
  the end-to-end pipeline.
- [Handler Explanation](./docs/Handler%20Explanation.md) --- the response
  tracker, automatic-navigation machine, and run lifecycle.

## Rules

- **Use `bytes()`, not `text()`, for anything that stores or forwards a body.**
  `text()` is UTF-8 and lossy --- a non-UTF-8 body round-trips with U+FFFD
  replacements.
- **The recorder filters omitted content types internally.** Call sites pass
  every settled `CollectorHttpResponse` unconditionally; `isOmittedContentType`
  from `http-extraction-fundamentals` decides what is kept.
- **Thread optional hooks through the composition, not the tracker.** The
  `captureProvenance` and `recorder` injection points follow the same pattern:
  declared optional on the handler's `make`, forwarded to the tracker's `make`.
- **`extraction-parity.test.ts` is load-bearing.** It is the only test that
  asserts the live tracker and the archive extraction produce the same
  resources. Do not weaken or skip it.
