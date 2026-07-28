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
  machine + run lifecycle). Provenance is core here: the framework mints the
  run id at dispatch and invokes the plan's optional `captureProvenance` hook
  at the tracker seam, and a settled batch structurally separates `resources`
  from best-effort `diagnostics`. No
  registry, no HTTP runtime, no React. Everything else depends on it; it depends
  on nothing else in the slice. Deliberately FHIR-agnostic — nothing here names
  a resource type.
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
  `collector-react`. Three today:
  [`fhir-r4-client-collector`](./fhir-r4-client-collector/AGENTS.md),
  [`rexall-be-well-collector`](./rexall-be-well-collector/AGENTS.md) (which also
  carries the Rexall carebook dialect it decodes with), and
  [`web-trace-collector`](./web-trace-collector/AGENTS.md) — the odd one out, a
  development-purposes _recorder_ that decodes nothing, claims every response,
  and writes each exchange as a FHIR `DocumentReference` via `web-trace-core`'s
  codec. It is also the only collector whose run ends when the **user** closes
  the sniffer window rather than when a script finishes. The two _production_
  collectors keep the source of what they produce too: each states one
  plan-level `captureProvenance` hook
  (`web-trace-core`'s `makeFhirProvenanceCapture('<prefix>')`), so every
  response that yielded a resource is stored verbatim as a trace
  `DocumentReference` linked to it — the framework does the rest.
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
- **Don't write a FHIR persist sink — pass `fhir-r4`'s `persistResources`
  straight to the descriptor.** It lives there, not in `collector-fundamentals`,
  because it needs `upsertResource` and the typed client while this slice's
  fundamentals stay FHIR-agnostic; that is exactly why it was three duplicated
  copies before it was consolidated. It takes **no options** — the write is
  `fhir-r4`'s, so the span it emits (`fhir.persist.write`) is named in that
  package's catalog, which is why `collector.importing.update` no longer exists
  here. The sink declares its own `ResourceWriteFailure`, structurally checked
  against `PersistFailure` when `CollectorDescriptor.make` receives it, so a
  drift is a compile error at every collector rather than a silent divergence.
- **A diagnostic resource rides the batch's `diagnostics` channel — never the
  `resources` array.** `SniffResult`'s success arm is a
  `SniffedBatch { resources, diagnostics }`: the split is structural, decided
  where the batch is built (the plan's `captureProvenance` hook), so nothing
  downstream re-derives it from resource shapes. The runner writes the primary
  half **first** through the _same_ injected sink (never a re-derived write —
  see the guardrail above) and reports its failures; diagnostics are written
  second, each failure WARN-logged by `label`/`id` and kept out of the
  summary — `collector-react`'s `collectImportSummary` folds **any** returned
  `PersistFailure` into `RunnerState: 'partial'` and fires the caller's
  `onError`, which is exactly why a diagnostic failure must never be returned.
  An empty half costs no call.
- **A `RemoteResponse` carries the sniffer's correlation `id` and the observed
  `startedAt`, and exposes the body two ways.** Most entities decode a known
  payload and use only `url` / `headers` / `text()`. An entity that _records_ an
  exchange rather than decoding one needs more: `id` (the sniffer's per-request
  key, which makes a stored exchange's id deterministic without threading a
  counter through `parse`), `startedAt` (the response-start instant the tracker
  observed — `parse` runs at settle, so reading a clock there would label the end
  as the beginning), and **`bytes()` rather than `text()`**. `text()` is UTF-8
  and therefore lossy: a body that is not valid UTF-8 comes back peppered with
  U+FFFD, and a re-encode of that string is not the body that arrived. Anything
  that stores, hashes, or forwards a body must read `bytes()`.
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

- **`Step` is a `Navigation | Delay | AwaitPageSettled | AwaitUserDismiss |
EnsureWindowVisible` union.** Two variants reach the wire — a `Navigation`'s
  `action` (typed against the bridge message bodies themselves) and
  `EnsureWindowVisible` (a fire-and-advance `EnsureSnifferVisible` show request).
  The three plan-only holds (`Delay`, `AwaitPageSettled`, `AwaitUserDismiss`) carry
  no payload and are consumed by the FSM, so they stay off the wire by construction
  — there is no "strip before dispatch" step to remember. A new scripted
  interaction is a `PageAction` `action` union variant, not a new bridge tag; a new
  _pause_ is a `Delay` (fixed) or `AwaitPageSettled` (wait for a matching settled
  page load) step, not a plan-wide delay field.
- **`EnsureWindowVisible` asks for the sniffer window on screen — best-effort,
  not a guarantee.** A fire-and-advance step (dispatches and advances like a
  `Navigation`) whose `EnsureSnifferVisible` message the host maps to
  `native_webview().show(SNIFFER_WEBVIEW_ID)` — re-presenting a hidden-but-alive
  webview, idempotent no-op if none exists. Place it right before `AwaitUserDismiss`
  so a webview the user dismissed earlier in the run (now alive but hidden) is
  brought back for them to close. Nothing acknowledges the show, so the machine
  advances either way: if no webview exists the following hold waits on a window
  that never appears, and it is that hold's `timeout` (or a `SnifferDisposed`)
  that ends the wait. The plugin's `show` can't tell "absent" from "already
  visible", so there is no failure for the host to report. Likewise a `Hidden`
  emitted _before_ the show is indistinguishable from a dismissal after it, so a
  stale one can release the hold early.
- **`AwaitUserDismiss` is a user-driven hold that _drains_, it does not
  complete.** It parks until the user closes the sniffer webview, then consumes
  the hold and keeps draining — it does **not** dispatch `SniffingComplete`
  itself. That is load-bearing: requests sniffed before the dismissal may still be
  in flight and the webview stays alive to finish them, so completing here would
  fire `SniffingComplete` against a non-empty request map and the results stream
  would never close (the run would hang until the idle timeout). Completion stays
  on the usual gate — queue drained ∧ every request settled.
- **Three things can end that hold, all via the same drain path:** the host→web
  `UserDismissed` message (synthesized from the plugin's `Hidden` lifecycle
  event), the step's own required `timeout` (WARN), and `SnifferDisposed`
  (synthesized from the plugin's `Disposed`, WARN). `Disposed` gets its **own
  tag** rather than being folded into `UserDismissed` because the run's own
  `SniffingComplete` teardown disposes the webview — one arrives on every run, so
  conflating them would race ordinary shutdown. Both signals are silent no-ops
  outside the hold.
- **A plan ending in `AwaitUserDismiss` must raise `ScrapingPlan.idleTimeout`
  above that step's `timeout`.** The sync runner's silent-host guard (default
  30 s) doesn't know the hold is waiting on a person, and will abandon the run
  long before the user acts — and before the hold's own bound can do its job.
  Note the runner's `idleTimeout` option, when passed, wins over the plan's.
  `web-trace-collector` is the one plan that uses the pairing today, and its
  `config.test.ts` pins the ordering.
- **Plan factories are `(config, runId) => plan` and deterministic given their
  inputs — the framework mints the id.** `CollectorDescriptor.make`'s
  `resourcePersistenceRuntimeIfMatches` mints one uuid per dispatch, applies
  the factory to it, and seals both into the `ResourcePersistenceContext` — a
  runtime instance _is_ one run, by construction. A factory that needs a
  per-run identity derives it from `runId` (the recorder's `sessionIdFor`,
  the provenance hook's session prefix) instead of minting its own, because
  `{sessionId}-{requestId}` is a trace's resource id and a stable id would
  silently upsert one run's traces over the previous run's. Consequence for
  tests: per-collector suites deep-equal plans built with a fixed run id; only
  `registry.test.ts`'s union-wide sweep still compares an identity
  _projection_, because the recorder's recording entity closes over the
  session id and two dispatches mint different ids.
- **Every `Step` carries a required `name`; the machine pushes it as a separate
  `SetSnifferStatus` control message, _not_ on the step's own action.** As the
  machine reaches each step it emits `SetSnifferStatus { name }`, which the Tauri
  host writes to the sniffer chrome's subtitle (`patch_window_text`) so a run is
  legible. This is how the plan-only holds can label the chrome despite carrying
  no `action`. Consequence: consecutive `Navigation` steps drain in one turn and
  their names flush back-to-back, so only the _last_ is visible — put a name that
  needs to be seen on a step that holds (`Delay` / `AwaitPageSettled` /
  `AwaitUserDismiss`) or on one immediately followed by a hold. Renaming/adding
  the tag is a wire change — keep
  `bridge.ts`, `events.rs`, and the `lib.rs` drift-guard test in lockstep.
- **Every `Navigation` dispatches and advances immediately — plans own their
  waits.** A `Fill` / `Click` / `Open` never waits for a `PageLoaded` (a
  `PageAction` fires none at all), so consecutive actions drain in one turn; a
  login is `Fill`/`Fill`/`Click` back-to-back. Any wait is an explicit step: a
  `Delay` for a fixed pause, or an **`AwaitPageSettled`** to hold until a settled
  `PageLoaded` matches a url pattern (aborting on its `timeout`). Two consequences:
  (1) after a `Click`/`Open` that navigates, gate the _next_ step with an
  `AwaitPageSettled` for the destination — don't expect the action itself to wait;
  (2) to keep the run open for post-load XHR fan-out, add a trailing
  `AwaitPageSettled` (wait for the page) and/or `Delay` (fixed grace) — otherwise
  the queue drains the instant the last action dispatches.
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
- **`captureProvenance` fires only for a non-empty successful parse — that rule
  is the line between deliberate provenance collection and bulk recording.**
  The tracker invokes the plan's hook inside `ResponseFinished`, the only place
  the "response → the resources it produced" pairing exists (the
  `RemoteResponse` is discarded the moment the settle is offered). A response
  that decoded to **nothing** is therefore never captured, and neither is a
  failed parse — if you want every exchange stored regardless, that is a
  recorder, i.e. its own entity claiming every response (see
  `web-trace-collector`), not a capture. Two more properties the tracker
  enforces: a failing or _dying_ hook is WARN-logged and the parse output flows
  on unchanged (a diagnostic never takes a run down, and the stream's error
  shape is untouched), and `followUpSteps` receives the **raw** parse output —
  generation runs before the hook — so a generator that opens a link per
  resource does not also fire for a provenance record.
- **The tracker's ordering is generate → capture → drop → offer.** A successful
  parse's `followUpSteps` are injected _before_ the settle is dropped and
  offered, so the machine leaves `Drained` before the offer's close-check can
  inject `NoMoreResultsExpected` — completion can't race ahead of the steps a
  settle produced. The provenance capture runs between generation and the
  drop, which is what guarantees `followUpSteps` never sees a hook-rewritten
  batch.
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
