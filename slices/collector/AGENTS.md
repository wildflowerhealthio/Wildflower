# AGENTS.md — slices/collector

Turns a stored collector config into resources written to their target: a user
taps "Import Now", a `browser-sniffer` webview scrapes the source, and the
decoded resources are written back through a per-collector persist sink. Read
the [Collector Sync Explanation](./collector-fundamentals/docs/Collector%20Sync%20Explanation.md)
before changing anything here, and the [Adding a Collector How-To](./docs/Adding%20a%20Collector%20How-To.md)
before adding one.

## Package roles

- **`collector-fundamentals`** — the pure vocabulary + the handler machines.
  `CollectorDescriptor` ("a collector" as one first-class value), the
  `ResourcePersistence*` write seam, `EntityDefinition` / `UrlMatch` /
  `ScrapingPlan` / `Step`, and the `./config-form` view contract, plus
  `CollectorBridgeMessageHandler` (the response tracker + automatic-navigation
  machine + run lifecycle). No registry, no HTTP runtime, no React. Everything
  else depends on it; it depends on nothing else in the slice.
- **`collector-registry`** — the **closed, compile-time** assembly. A single
  `descriptors` tuple lists every collector; the `CollectorConfig` union, the
  `CollectorTag` literal, `CollectorRequirements`, and the
  `resourcePersistenceRuntimeForConfig` dispatch are all _derived_ from it. Also
  owns the `CollectorBridge` wire contract and the remotes `HttpApi` definition
  and generated client. Most-downstream TS package: it statically imports each
  `*-client-collector`.
- **`*-client-collector`** (`fhir-r4-client-collector`, …) — one
  `CollectorDescriptor` per import site: config schema + arbitraries, scraping
  plan, entities, display strings, persist sink, and the collector's own
  `ConfigForm`. Depends on `collector-fundamentals` only — never on
  `collector-react`. (`fhir-r4-client-collector` and `rexall-be-well-collector`
  are the two today; the latter also carries the Rexall
  [carebook dialect](./rexall-be-well-collector/AGENTS.md) it decodes with.)
- **`collector-react`** — the browser UI adapter: the generic account
  create/edit/list screens, the closed `tag → ConfigForm` registry
  (`src/forms/config-form.tsx`), the remotes queries/mutations, and the sync
  runner (`src/runtime/`, framework-free core in `sync-run.ts`).
- **`collector-rust`** — the remotes store (diesel) behind the `/collector`
  HTTP surface, and the committed OpenAPI snapshot the drift check pins.

## Guardrails

- **The registry is closed and compile-time — there is no runtime registry.**
  Registering a collector is two static edits: append its descriptor to
  `collector-registry`'s `descriptors` tuple, and register its form in
  `collector-react`'s `configForms` map. The config/tag/requirements unions and
  the dispatch all derive from the tuple, and the `configForms` mapped type
  fails to compile until the new tag's form is registered — no parallel
  switch/union to keep in sync.
- **A descriptor's `persistResources` owns _how_ a batch is written and must
  never fail.** It handles its own retries, per-resource spans, and concurrency,
  and returns the resources it could not write as `PersistFailure` data on a
  `never` error channel — so one bad resource can't fail the run. The runner
  owns only _when_ to write and how to fold failures into the summary. Only the
  resource type is sealed (existential `Resources`); the write requirement `R`
  stays visible so the registry can surface `CollectorRequirements`.
- **First `isFoundAt` match wins, so overlapping URL patterns are a silent
  ordering dependency — keep them disjoint.** `CollectorBridgeMessageHandler`
  consults `entityDefinitions` in list order at each `ResponseStart`; a
  too-broad pattern earlier in the list shadows a later entity. Make patterns
  disjoint by construction, e.g. `mustHaveQuery` on a list-by-query pattern so
  it can't also match a single-resource URL (see `UrlMatch`).
- **A new config in the union changes the remotes API wire schema — regenerate
  the OpenAPI snapshots.** `CollectorConfig` is the payload of
  `CreateRemote`/`UpdateRemote`; widening it drifts the committed spec. Run
  `UPDATE_OPENAPI=1 cargo test -p collector-rust openapi_spec_snapshot_is_up_to_date`
  and `vp test openapi-drift`. See the
  [How-To](./docs/Adding%20a%20Collector%20How-To.md) and the
  [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).
- **The `/collector` endpoints are owner-only and are NOT gated in-slice.**
  `collector-registry` can't depend on `gatekeeper-core` (slice layering), so
  the composition site must apply `.middleware(RequireAuthMiddleware)`. A future
  composer that forgets this exposes write endpoints to unauthenticated clients
  (a compile-time guard lives in `apps/wildflower-server`).

## Traps

- **`Step` is a `Navigation | Delay` union; only `NavigationStep.action` reaches
  the wire.** The automatic-navigation machine forwards only a `Navigation` step's
  `action` (typed against the bridge message bodies themselves), so both the
  plan-only `advanceWhen` gate and the whole `Delay` variant stay off the wire by
  construction — there is no "strip before dispatch" step to remember. A new
  scripted interaction is a `PageAction` `action` union variant, not a new bridge
  tag; a new _pause_ is a `Delay` step, not a plan-wide delay field.
- **There is no implicit inter-step settle — plans own their grace periods.** A
  `Navigation` dispatches on the same transition as its gating `PageLoaded`, and
  the run closes the stream the moment both completion gates hold. If post-load
  XHR fan-out must finish before the run completes, add an explicit **trailing
  `Delay` step** (it delays reaching `Drained`, keeping the run open while those
  requests start and are tracked).
- **Completion couples the two machines — `Drained ∧ all requests settled`.** The
  automatic-navigation machine can't complete on an empty queue alone (an in-flight
  request may still `followUpSteps`). It reaches `Done` only when the lifecycle
  injects `NoMoreResultsExpected` (map empty) _and_ its queue is drained; the
  re-check fires on _both_ edges (a settle emptying the map, and the queue draining
  via `onDrained`). `SniffingComplete` therefore fires only once every sniffed
  request has settled — completion waits on Gate B. The `handleSniffingComplete`
  hook must never re-inject `NoMoreResultsExpected` (re-entrant lock → deadlock);
  it only closes the stream.
- **`followUpSteps` generation is guarded at the injection point, not in the pure
  transition.** The composition (`collector-bridge-message-handler.ts`) dedups
  generated `Open`s by `Uri` (a run-wide visited-set seeded with `firstPage` +
  authored `Open`s) and caps total generated steps at `maxGeneratedSteps`
  (default 500) — both adjustable per-plan (`dedupeGeneratedOpenUris`,
  `maxGeneratedSteps`). Dropped steps WARN-log with counts. These two are the
  termination guards for the naturally-recursive entity-hung generators.
- **The tracker's ordering is generate → drop → offer.** A successful parse's
  `followUpSteps` are injected _before_ the settle is dropped and offered, so the
  machine leaves `Drained` before the offer's close-check can inject
  `NoMoreResultsExpected` — completion can't race ahead of the steps a settle
  produced.
- **The sync drive loop is a decision table, not a state machine, and
  completion is not computed in the runner.** It drains the handler's
  `requestSniffingResults` stream until that stream finishes; the handler closes
  it once sniffing is complete and every response has settled. `idleTimeout` is
  the escape hatch for a silent host. Contrast the automatic-navigation machine,
  which _is_ an FSM (overlapping delay/URL-match timers).
- **`CollectorConfig` is TS-owned and opaque to Rust.** `collector-rust` stores
  and serves the config JSON verbatim; its utoipa field is
  `#[schema(value_type = Value)]` (an empty schema the drift engine treats as a
  wildcard), so adding a TS collector never trips the drift gate on the server
  side — only the client snapshot moves.

## References

- [Adding a Collector How-To](./docs/Adding%20a%20Collector%20How-To.md) — the
  end-to-end checklist for a new collector.
- [Collector Sync Explanation](./collector-fundamentals/docs/Collector%20Sync%20Explanation.md)
  — the Context/Program/Runtime write seam and the drive loop.
- [Handler Explanation](./collector-fundamentals/docs/Handler%20Explanation.md)
  — the response tracker + automatic-navigation machine that turn sniffer events
  into decoded resources.
- [browser-sniffer AGENTS.md](../browser-sniffer/AGENTS.md) — the upstream
  page-sniffing primitive this slice consumes.
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the
  webview ↔ host channel the sniffer/collector messages cross.
- [HttpApi Composition How-To](../../docs/Effect/HttpApi%20Composition%20How-To.md)
  — how the `/collector` group composes into the app `HttpApi`.
- [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md)
  — regenerating the committed snapshot after a wire change.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
