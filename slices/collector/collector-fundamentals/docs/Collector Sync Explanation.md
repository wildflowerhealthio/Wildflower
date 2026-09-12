# Collector Sync Explanation

How one "Import Now" click turns a stored collector config into resources
written to their target, and how the pieces fit together. Read this first;
then each module makes sense in its slot. For the message-handling machines
that sit _inside_ this pipeline (the response tracker and the automatic-navigation machine),
see the [Handler Explanation](./Handler%20Explanation.md).

## The pipeline, end to end

```text
CollectorConfig                        a stored remote's config (e.g. fhir-r4)
   │
   ▼  collector-registry
resourcePersistenceRuntimeForConfig(config)
   │        dispatch to the owning CollectorDescriptor; returns a
   │        ResourcePersistenceRuntime with the resource type sealed
   ▼  collector-react (use-sync-runner)
runtime.run(context => buildImportEffect({ context, ...wiring }))
   │        provide the sealed context to the program; get a runnable Effect
   ▼  collector-react (sync-run)
buildImportEffect  ── the drive Stream ─►  CollectorBridgeMessageHandler
   │   pulls parsed resources off a mailbox,        (sniffs pages, decodes
   │   writes each batch, folds the failures         responses to Resources)
   │                                                      │
   │                                                      ├─►  RunRecorder (optional)
   │                                                      │      every response that
   │                                                      │      finished on the wire,
   │                                                      │      claimed or not, minus
   │                                                      │      scripts/styles/media —
   │                                                      │      as Extraction.Inputs in
   │                                                      │      settle order. Recorded
   │                                                      │      before the parse runs,
   │                                                      │      so it is a record of the
   │                                                      │      traffic, not of the
   │                                                      │      extraction.
   ▼
persistResources(batch)                the descriptor's batch write sink
   │        (fhir-r4: retries + spans around fhir-r4's upsertResource,
   │         which routes each PUT to the typed FhirR4ResourcesHttpApiClient)
   ▼
target store
```

The recorder hangs off the handler rather than sitting in the flow: the run's
resources reach the store exactly as they did before it existed, and the
recording is a second, passive read of the same traffic. The runner injects it
(recording is a property of the run, not of the plan) and drains `entries()`
when the run ends. See
[The run recorder](./Handler%20Explanation.md#the-run-recorder-seeing-what-routing-discards).

The runner in the middle (`buildImportEffect`) never names a collector's
resource type. It hands each decoded batch to the injected `persistResources`
and folds the failures that come back into the summary. That is what let the
old cross-package `AnyCollectorResource` union — and the FHIR `switch` that
used to live in the runner — disappear.

## The three collaborators: Context, Program, Runtime

Retiring `AnyCollectorResource` means the runner must drive a config's writes
_without naming the resource union_. Three types make that work; they are one
collaboration, named as the `ResourcePersistence*` family (defined in
`model/resource-persistence-runtime.ts`).

- **`ResourcePersistenceContext<Resources, R>`** — one config's resolved
  operations: its already-applied `scrapingPlan` and its batch
  `persistResources`, both over the _same_ concrete `Resources`. This is the
  value the runner works from. `persistResources` returns the resources it
  could not write as `PersistFailure` data on a `never` error channel, so one
  bad resource can't fail the run and the runner's failure accounting reads
  straight off the return.
- **`ResourcePersistenceProgram<R, A>`** — a resource-_generic_ body,
  `<Resources>(context) => A`. Because it is generic in `Resources` it cannot
  assume or name the concrete union. `A` is left unconstrained on purpose: the
  existential is sound precisely because the result can't mention `Resources`,
  effectful or not. The sync runner's
  `context => buildImportEffect({ context, ...wiring })` is the one concrete
  program (its `A` is `Effect<ImportSummary, never, R>`).
- **`ResourcePersistenceRuntime<R>`** — the per-config carrier the registry
  hands back. You give its `run` a Program; it provides the sealed Context
  and returns the Program's result — "provide the context, get a runnable
  effect". Its only constructor is `ResourcePersistenceRuntime.make`, which
  `CollectorDescriptor.make` calls with the config's applied plan + persist
  sink, sealing the single hidden `Resources`.

`R` (the write requirement — for fhir-r4, `FhirR4ResourcesHttpApiClient`) is
_not_ hidden. It stays a visible type parameter so the registry can surface
`CollectorRequirements` (the union of every descriptor's `R`) for the authed
runner to provide. Only `Resources` is sealed.

### Why an existential, and not an Effect `Service`

A reasonable first instinct is "make the operations an Effect `Service`/`Layer`
and provide it." That cannot replace this, and the difference is the reason
the family exists:

- An Effect `Service` (`Context.Tag<Id, Value>`) hides a **value** in the `R`
  channel and looks it up at the value level. It does **not** hide a **type
  parameter**. A `Service` carrying these three functions would still have to
  name `Resources` in its type (`Ops<Resources>`), pushing the union back onto
  every consumer — exactly what we are removing.
- What must be hidden is the _type_ `Resources`, not a value. That is an
  **existential** (`∃Resources. { plan, persistResources }`), which
  TypeScript expresses through the CPS / rank-2 encoding above: `run` takes a
  Program that is itself generic in `Resources`, so the caller cannot name the
  concrete union. The one implementer applies the Program to the single hidden
  `Resources` it closed over, and returns a value that never mentions
  `Resources` (the `Effect<…, …, R>`). Sound, with no cast.

At runtime this is trivial — the whole encoding is type-level; `run` is a
one-line "apply the Program". `context.scrapingPlan` is the **already-applied**
plan; the factory `makeScrapingPlan(config)` lives on the descriptor.

## Where writes are routed: the descriptor

Each `*-client-collector` package exports one `CollectorDescriptor`. The
registry assembles them into a closed, compile-time list and derives
everything from it — the config union, the tag literal,
`CollectorRequirements`, and the `resourcePersistenceRuntimeForConfig`
dispatch — so there is no parallel switch to keep in sync.

`persistResources` is the seam. Every collector targeting the on-device FHIR R4
store uses `fhir-r4`'s `persistResources`, which owns everything about _how_ a
batch is written — `WRITE_CONCURRENCY`, the retry/backoff schedule, the
per-resource span — on top of `fhir-r4`'s reusable `upsertResource` (the
`switch (resource.resourceType)` that PUTs each resource to its typed client
endpoint). It returns the resources it could not write as failure data rather
than failing. The runner owns only _when_ to write, the batch
`collector.importing` span, and folding those failures into the summary.

The sink lives in `fhir-r4` rather than here because it needs `upsertResource`
and the typed client, and `collector-fundamentals` is deliberately FHIR-agnostic
— which is exactly why it was three duplicated copies before it was
consolidated. It takes no options: the write is `fhir-r4`'s, so it emits
`fhir.persist.write` from that package's own catalog, and a trace reads
`collector.importing` → `fhir.persist.write` → `PUT`. The failure record is
declared there too — `fhir-r4` sits below this slice and cannot name it — and is
checked against `PersistFailure` structurally at each `CollectorDescriptor.make`
call.

## The drive loop and its completion predicate

`buildImportEffect` models the whole sync as one long, interruptible Effect on
a single fiber. It builds the `CollectorBridgeMessageHandler`, registers it,
kicks the automatic-navigation machine (whose leading `Open` step is what
brings the sniffer webview up), and then runs the **drive Stream**
(`processSniffResultsFromMailbox`), folded into the `ImportSummary` by `collectImportSummary`.
The handler publishes each settled outcome — a decoded batch (`Right`) or a
sniff-level parse/transport failure (`Left`) — onto its own
`requestSniffingResults` stream, which `processSniffResultsFromMailbox` reads directly (no
`onResult` callback, no adapter in between). Each drive step pulls one result and
writes the batch inline — the primary `resources` first (their failures are the
step's output), then any `diagnostics` best-effort through the same sink, each
diagnostic failure WARN-logged and kept out of the summary — emitting the
primary batch's `PersistFailure`s as the step's stream element. The run's output is thus _produced by the Stream_ — the fold is
where `setFailed` / `onError` fire and the summary accumulates.

The step is a plain decision table — **not** a state machine. (Contrast the step
machine, which _is_ an FSM because it models concurrent, interruptible timers.
This loop has no such concurrent state; forcing a transition table onto it
would add ceremony for no benefit.) It is expressed with `Stream.paginateEffect`
specifically because that emits its element on the _terminal_ step too — how the
idle-timeout abandon tail reports its failures and ends the stream at once.
`processSniffResultsFromMailbox` is a plain generic function handed the handler's read-only
`requestSniffingResults` stream; **completion is folded into that stream**. There
is no `isSettled` predicate and no incomplete-request map in the runner — the
handler's run lifecycle closes `requestSniffingResults` once sniffing is complete
_and_ no sniffed request is still incomplete (see the
[Handler Explanation](./Handler%20Explanation.md)), so the loop just drains until
the stream reports done:

```text
                 ┌──────────────────────────────┐
   each iteration │  take next result (blocking) │
                 └──────┬───────────────┬────────┘
                  result│          done │
                        ▼               ▼
                 process, loop        DONE
                                (stream drained)
```

- **`done`** is a `take` on a finished, drained stream failing with
  `NoSuchElementException`. `end`ing a non-empty mailbox leaves it _draining_, so
  every queued result is taken before `done` — the tracker's drop-then-offer
  order (it offers the result before the close-check runs) guarantees the final
  result is queued before the stream closes.
- **There is no runner-side idle guard, but the run is still bounded.** The loop
  blocks on `take` until the stream is done. A plan's _navigation_ is bounded by
  its own step holds' `timeout`s (a terminal `AwaitPageSettled`, an
  `AwaitUserDismiss`, …), whichever is parked when a host goes quiet. Those bound
  only the step queue, though: a sniffed request that starts (`ResponseStart`
  seen) but whose `ResponseData` chunks never produce a terminal keeps the
  completion gate (queue drained ∧ every request settled) unmet at a point where
  no hold is parked and no timer is armed. The **drained guard** covers exactly
  that window — armed by the automatic-navigation machine on entry to `Drained`
  under the plan's `drainedGuardTimeout` (default 60 s), cancelled the moment the
  queue re-awakens or the run completes, and wired to the handler's
  `abandonAllRequestSniffing`, which publishes each stalled request as a failure
  and closes the stream. So a stalled host ends the run as a reported partial
  result instead of parking until the user cancels.

On completion (or an explicit cancel via the run's `AbortSignal`) the Effect's
`release` tears the handler down: `cancelAllRequestSniffing` → `unregister`.

## The React shell

`use-sync-runner.ts` is the thin React layer: the `useMutation` wiring, the
per-run `AbortController`, and the `RunnerState` mapping (`idle` / `running` /
`partial` / `errored` / `done`). It injects `setFailed` / `onError` as plain
functions and provides `R` through the router context's authed runner. It
holds no drive logic — that all lives framework-free in `sync-run.ts`, which is
why the loop is testable with `TestClock` and no React Testing Library.

## See also

- [Handler Explanation](./Handler%20Explanation.md) — the response tracker and
  the automatic-navigation machine that turn raw sniffer events into decoded resources.
- [Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md) —
  the webview ↔ host bridge the sniffer events cross.
- `model/resource-persistence-runtime.ts`, `collector-react/src/runtime/sync-run.ts`,
  and `collector-registry/src/registry.ts` — the code this doc narrates.
