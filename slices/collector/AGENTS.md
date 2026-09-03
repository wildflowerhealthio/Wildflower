# AGENTS.md — slices/collector

Turns a stored collector config into resources written to their target: a user
taps "Import Now", a `browser-sniffer` webview scrapes the source, and the
decoded resources are written back through a per-collector persist sink. Read
the [Collector Sync Explanation](./collector-fundamentals/docs/Collector%20Sync%20Explanation.md)
before changing anything here, and the [Adding a Collector How-To](./docs/Adding%20a%20Collector%20How-To.md)
before adding one.

## Package roles

- **`collector-fundamentals`** — the collector vocabulary + the handler
  machines, built on `http-extraction-fundamentals` (which owns
  `HttpResponseKind` / `UrlMatch` / `HttpResponse` — the decode vocabulary the
  `http-extraction` slice defines and this slice runs live).
  `CollectorDescriptor` ("a collector" as one
  first-class value), the `ResourcePersistence*` write seam,
  `CollectorHttpResponseKind` (an `HttpResponseKind` extended with the
  live-only `followUpSteps` crawl seam) / `ScrapingPlan` / `Step` /
  `CollectorHttpResponse` (the live, chunk-accumulating implementation of
  `HttpResponse`), and the `./config-form` view contract, plus
  `CollectorBridgeMessageHandler` (the response tracker + automatic-navigation
  machine + run lifecycle). Provenance is core here: the framework mints the
  run id at dispatch and invokes the plan's optional `captureProvenance` hook
  at the tracker seam, and a settled batch structurally separates `resources`
  from best-effort `diagnostics`. No registry, no HTTP runtime, no React.
  Everything else in the slice depends on it; within the slice it depends on
  nothing, and outside it only on `http-extraction-fundamentals` — the
  archive-driven counterpart of the tracker (`runExtraction`, the reference
  model in that package's test-helpers) lives there, and
  `src/handler/extraction-parity.test.ts` here pins that the two route and
  decode identically. Deliberately FHIR-agnostic — nothing here names a
  resource type.
- **`collector-registry`** — the **closed, compile-time** assembly. A single
  `descriptors` tuple lists every collector; the `CollectorConfig` union, the
  `CollectorTag` literal, `CollectorRequirements`, and the
  `resourcePersistenceRuntimeForConfig` dispatch are all _derived_ from it. Also
  owns the `CollectorBridge` wire contract and the remotes `HttpApi` definition
  and generated client. Most-downstream TS package: it statically imports each
  `*-client-collector`.
- **`*-client-collector`** (`fhir-r4-client-collector`, …) — one
  `CollectorDescriptor` per import site: config schema + arbitraries, scraping
  plan, display strings, persist sink, and the collector's own `ConfigForm`.
  A source's decode lives in its **source package** under
  `slices/http-extraction/` (`fhir-r4-source` is the worked example); the
  collector package layers navigation and persistence on top of those
  entities, depending on `collector-fundamentals` and its source package —
  never on `collector-react`, and never the reverse direction. Five today:
  [`fhir-r4-client-collector`](./fhir-r4-client-collector/AGENTS.md),
  [`rexall-be-well-collector`](./rexall-be-well-collector/AGENTS.md) (over the
  Rexall carebook dialect in `rexall-be-well-source`),
  [`shoppers-drugmart-collector`](./shoppers-drugmart-collector/AGENTS.md) and
  [`lifelabs-collector`](./lifelabs-collector/AGENTS.md) (both over bespoke
  portal JSON their source packages synthesize R4 from; LifeLabs is
  captcha-gated, so its plan never clicks submit), and
  [`web-trace-collector`](./web-trace-collector/AGENTS.md) — the odd one out, a
  development-purposes _recorder_ that decodes nothing, claims every response,
  and writes each exchange as a FHIR `DocumentReference` via `web-trace-core`'s
  codec. It is also the only collector whose run ends when the **user** closes
  the sniffer window rather than when a script finishes. The _production_
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
- **A `CollectorHttpResponse` carries the sniffer's correlation `id` and the observed
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
- **Routing is highest-specificity-wins, ties → list order, so overlapping
  same-specificity patterns are a silent ordering dependency — keep them
  disjoint.** `CollectorBridgeMessageHandler` routes each `ResponseStart` through
  `Extraction.routeTo`, which ranks the kinds whose `tryRecognize` claims the URL
  by `specificity` and breaks a tie by list order. A too-broad pattern at the
  same tier earlier in the list then shadows a later entity. Make patterns
  disjoint by construction, e.g. `mustHaveQuery` on a list-by-query pattern so it
  can't also match a single-resource URL (see `UrlMatch`). `specificity` only
  disambiguates a **cross-source** pool (the importer's flat pool); within one
  collector plan every kind sits at the same tier, so intra-plan disjointness is
  still required. An archive import routes through
  the same `routeTo`, so an entity list shadows identically live and in an
  archive import — that is deliberate: a source must not decode one thing through
  a webview and another through an archive.
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

- **`Step` is a `Navigation | Delay | AwaitPageSettled | AwaitPageRequested |
AwaitUserDismiss | EnsureWindowVisible` union.** Two variants reach the wire — a
  `Navigation`'s `action` (typed against the bridge message bodies themselves) and
  `EnsureWindowVisible` (a fire-and-advance `EnsureSnifferVisible` show request).
  The four plan-only holds (`Delay`, `AwaitPageSettled`, `AwaitPageRequested`,
  `AwaitUserDismiss`) carry no payload and are consumed by the FSM, so they stay
  off the wire by construction — there is no "strip before dispatch" step to
  remember. A new scripted interaction is a `PageAction` `action` union variant,
  not a new bridge tag; a new _pause_ is a `Delay` (fixed), `AwaitPageSettled`
  (wait for a settled page load matching its `pattern` — or, with **no** `pattern`,
  the _next_ settled load, which is the idiom right after an `Open` to that page),
  or `AwaitPageRequested` (wait for a
  matching page to merely _arrive_ — the sniffer's `PageRequested` fired at
  `DOMContentLoaded`; use it when the awaited page may never satisfy the settle
  detector, e.g. a busy SPA behind a 2FA pause — a matching settled load also
  releases it, but a mere arrival never releases an `AwaitPageSettled`) step, not
  a plan-wide delay field.
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
  would never close. Completion stays on the usual gate — queue drained ∧ every
  request settled — with the machine's **drained guard** as the backstop if a
  request in that map never terminates.
- **Three things can end that hold, all via the same drain path:** the host→web
  `UserDismissed` message (synthesized from the plugin's `Hidden` lifecycle
  event), the step's own required `timeout` (WARN), and `SnifferDisposed`
  (synthesized from the plugin's `Disposed`, WARN). `Disposed` gets its **own
  tag** rather than being folded into `UserDismissed` because the run's own
  `SniffingComplete` teardown disposes the webview — one arrives on every run, so
  conflating them would race ordinary shutdown. Both signals are silent no-ops
  outside the hold.
- **A plan ending in `AwaitUserDismiss` bounds itself through that step's own
  `timeout` — there is no runner-side idle guard to fight.** The hold waits on a
  person, so its `timeout` legitimately spans a long manual session (set it
  generously); nothing else caps the wait. The plan-level `drainedGuardTimeout`
  does not, either: that guard is armed only in `Drained`, and this hold parks the
  machine in `AwaitingUserDismiss`, so it cannot fire during the manual session —
  which is exactly the conflict that got the old rolling idle guard removed.
  `web-trace-collector` is the one plan that uses the pairing today
  (`USER_DISMISS_TIMEOUT` = 2 h).
- **Plan factories are `(config, runId) => plan` and deterministic given their
  inputs — the framework mints the id.** `CollectorDescriptor.make`'s
  `resourcePersistenceRuntimeIfMatches` mints one uuid per dispatch, applies
  the factory to it, and seals both into the `ResourcePersistenceContext` — a
  runtime instance _is_ one run, by construction. A factory that needs a
  per-run identity derives it from `runId` (e.g. `web-trace-collector`'s
  `sessionIdFor`) instead of minting its own, because a trace's resource id is
  derived from `(sessionId, requestId)` and a stable id would silently upsert
  one run's traces over the previous run's. Consequence for tests: per-collector
  suites deep-equal plans built with a fixed run id; only `collector-registry`'s
  `registry.test.ts` union-wide sweep compares an identity _projection_ —
  `name`, the leading `Open`'s URI, the step names (`_tag:name`), and the entity
  names — rather than deep-equal. Two independent facts defeat deep equality
  there, so even a fixed id would not save it: `web-trace-collector`'s recording
  entity closes over a per-run session id, and a per-build entity factory mints a
  fresh `parse` closure each time (`toEqual` compares functions by reference).
  The projection still fails loudly on a mis-dispatch (a plan from the wrong
  descriptor differs in all four fields) without asserting a purity the interface
  never promised. Module-scope pre-adoption is what keeps deep-equal working for
  the per-collector suites: a production collector's kinds are wrapped with
  `adoptUnderRecognizedRoot` **once at module load** (the combinator takes no
  source parameter — identity is read per response inside `parse` — so there is
  nothing to parameterize and no memo), and every plan a config builds names the
  same frozen kind by identity.
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
  `PageLoaded` matches a url pattern (aborting on its `timeout` by default, or
  advancing to the next step when the hold sets `continueOnTimeout: true` — for a
  best-effort page an already-authenticated session may skip). Two consequences:
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
  generated `Open`s by `Uri` (a run-wide visited-set seeded with the authored
  `Open`s — which include the run's first navigation) and caps
  total generated steps at `maxGeneratedSteps`
  (default 500) — both adjustable per-plan (`dedupeGeneratedOpenUris`,
  `maxGeneratedSteps`). Dropped steps WARN-log with counts. These two are the
  termination guards for the naturally-recursive entity-hung generators.
- **`captureProvenance` fires only for a non-empty successful parse — that rule
  is the line between deliberate provenance collection and bulk recording.**
  The tracker invokes the plan's hook inside `ResponseFinished`, the only place
  the "response → the resources it produced" pairing exists (the
  `CollectorHttpResponse` is discarded the moment the settle is offered). A response
  that decoded to **nothing** is therefore never captured, and neither is a
  failed parse — if you want every exchange stored regardless, that is a
  recorder, i.e. its own entity claiming every response (see
  `web-trace-collector`), not a capture. Two more properties the tracker
  enforces: a failing or _dying_ hook is WARN-logged and the parse output flows
  on unchanged (a diagnostic never takes a run down, and the stream's error
  shape is untouched), and `followUpSteps` receives the **raw** parse output —
  generation runs before the hook — so a generator that opens a link per
  resource does not also fire for a provenance record. **An archive import never
  invokes it at all** — `http-extraction-fundamentals`' extraction path knows
  only the base `HttpResponseKind`, so neither `captureProvenance` nor
  `followUpSteps` exists on that path (an import already has its source as one artifact, and
  there is nothing to navigate).
- **`CollectorHttpResponse` answers a _recorder_'s questions, not just a decoder's.**
  The seam exposes everything an entity may know about a response, including the
  three a capturing entity needs that a decoding one ignores: the sniffer's
  correlation `id` (so a stored record keys on `(sessionId, requestId)` and a
  retried write is an idempotent upsert, not a threaded counter), `startedAt`
  (the `ResponseStart` instant — `parse` runs at settle, so an entity reading
  its own clock there would timestamp the response's end as its beginning), and
  `bytes()` (lossless; `text()` corrupts a non-UTF-8 body, and its return is
  pinned to `Uint8Array<ArrayBuffer>` so platform `BufferSource` calls need no
  cast). A seam shaped around one consumer silently bakes in that consumer's
  assumptions — add the field the second consumer needs to the response, don't
  re-derive it downstream.
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
  it once sniffing is complete and every response has settled. There is **no
  runner-side idle guard** — a plan bounds its navigation through its step-hold
  `timeout`s, and the _tail_ is bounded by the machine's drained guard (see the
  next trap). Contrast the automatic-navigation machine, which _is_ an FSM
  (overlapping delay/URL-match timers).
- **Step holds bound the queue; the drained guard bounds the requests.**
  Completion needs both gates, and a hold's `timeout` only ever bounds Gate A. A
  sniffed request that emits `ResponseStart` and never reaches a terminal event
  leaves Gate B unmet _after_ the queue has drained — at which point the machine
  is parked on no hold and nothing is armed. The machine therefore arms a guard on
  entering `Drained` (plan-level `drainedGuardTimeout`, default 60 s) and cancels
  it the instant the queue re-awakens or the run completes; its expiry drives
  `abandonAllRequestSniffing`, so the stall lands as a reported partial failure
  rather than a permanent hang. Scoping it to `Drained` is what keeps it from
  re-creating the rolling idle guard that fought `AwaitUserDismiss`.
- **`CollectorConfig` is TS-owned and opaque to Rust.** `collector-rust` stores
  and serves the config JSON verbatim; its utoipa field is
  `#[schema(value_type = Value)]` (an empty schema the drift engine treats as a
  wildcard), so adding a TS collector never trips the drift gate on the server
  side — only the client snapshot moves.

## References

- [Adding a Collector How-To](./docs/Adding%20a%20Collector%20How-To.md) — the
  end-to-end checklist for a new collector.
- [Source Identity Explanation](./docs/Source%20Identity%20Explanation.md) — why an
  imported resource is re-keyed under a derived local id, and what happens to its
  references.
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
