# Adding a Collector How-To

The end-to-end checklist for adding a new collector — a source the "Import Now"
flow can scrape and write back. For _why_ the pieces fit together the way they
do, read the [Collector Sync Explanation](../collector-fundamentals/docs/Collector%20Sync%20Explanation.md)
first; this doc is the recipe. `fhir-r4-client-collector` is the worked example
throughout.

A collector is registered with exactly **two static edits** — its descriptor
into `collector-registry`, its form into `collector-react` — because the slice
has no runtime registry (see [slices/collector/AGENTS.md](../AGENTS.md)).
Everything before those two edits lives in a new `*-client-collector` package
that depends on `collector-fundamentals` only.

## What you're building

| Piece          | Where                                       | Contract                                                       |
| -------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Entities       | `*-client-collector/src/entities/`          | `EntityDefinition.make` — recognize + parse one response shape |
| Config         | `*-client-collector/src/config.ts`          | `Schema.TaggedStruct` + fast-check arbitraries                 |
| Scraping plan  | `*-client-collector/src/config.ts`          | `ScrapingPlan.make` — first page, steps, entities              |
| Persist sink   | `*-client-collector/src/config.ts`          | import `fhir-r4`'s `persistResources` — don't write your own   |
| Provenance     | `*-client-collector/src/provenance.ts`      | `withCapturedSource` + `withDiagnosticResources` wiring        |
| Descriptor     | `*-client-collector/src/config.ts`          | `CollectorDescriptor.make` — bundles all of the above          |
| Config form    | `*-client-collector/src/*-config-form.tsx`  | `ConfigFormProps<Config>`                                      |
| Registry entry | `collector-registry/src/registry.ts`        | append to `descriptors`                                        |
| Form entry     | `collector-react/src/forms/config-form.tsx` | add to `configForms`                                           |

## 1. Scaffold the client-collector package

Copy `fhir-r4-client-collector`'s `package.json`, `tsconfig.json`, and
`vite.config.ts` and rename. Depend on `collector-fundamentals` (peer +
`workspace:*`), `effect`, and whatever slice owns the target write API (for FHIR
that's `fhir-r4`). Add `react` / `react-kitchen-sink` / `react-tundraish` only
because the config form lives here; the form's props contract
(`collector-fundamentals/config-form`) is React-free so the descriptor stays
importable by non-UI layers. **Do not** depend on `collector-react` — that would
invert the slice layering.

Run `vp install` after adding the package so the workspace picks it up.

## 2. Define entities

An `EntityDefinition` (`collector-fundamentals/model`) is a recipe the handler
uses to _recognize_ a response by URL and _decode_ it to resources:

```ts
const patientUrl = UrlMatch.make({ segments: [UrlMatch.literal('Patient'), UrlMatch.id] })

const PatientEntity = EntityDefinition.make({
  name: 'PatientEntity',
  isFoundAt: (url) => patientUrl.test(url),
  parse: (response) => Effect.map(decode(extractJson(response.text())), (p) => [p]),
})
```

- **`UrlMatch.make({ segments, end? })`** builds the recognizer regex from named
  path segments (`UrlMatch.literal('Patient')`, `UrlMatch.id`) so you don't
  hand-write boundary regexes. It's unanchored and tolerates a base path between
  host and segments (real servers mount under `/baseR4`, `/fhir/R4`, …).
- **Keep patterns disjoint — first `isFoundAt` match wins.** The handler
  consults entities in list order; a broad pattern earlier shadows a later one.
  Where a list-by-query URL (`…/Observation?subject=…`) and a single-resource
  URL (`…/Observation/123`) would both match, pin the list pattern with
  `end: 'mustHaveQuery'` so the two are structurally disjoint.
- **`parse` returns an `Effect`** (`ParseError` in the error channel), not an
  `Either`, so an entity can `Effect.logInfo` dropped entries. Emit `[]` for a
  resource you can't use (e.g. a null id) rather than failing. `parse` stays a
  **pure decode** — it never emits navigation.
- **`followUpSteps` (optional) is the reactive-crawl seam.** A pure, synchronous
  `(resources, response) => Step[]`: every time this entity's `parse` succeeds,
  the returned steps are appended to the back of the navigation queue (open every
  page a parsed list/table links, resolving relative links against
  `response.url`). It is naturally recursive; run-wide URI dedup of generated
  `Open`s and the plan's `maxGeneratedSteps` cap keep it terminating. Omit it for
  a leaf entity. (Kept a named field, not a `parse` side-channel, so generation
  stays statically visible and the handler owns its invocation.)

## 3. Config schema + arbitraries

The per-instance config is a `Schema.TaggedStruct` whose `_tag` is the
collector's registry key. Constrain each field, and annotate an `arbitrary` so
property tests generate valid configs straight from the schema:

```ts
const InstanceConfig = Schema.TaggedStruct('fhir-r4', {
  rootUrl: RootUrlSchema, // .annotations({ arbitrary: () => arbitraryRootUrl })
  patientId: PatientIdSchema,
})
const defaultConfig: typeof InstanceConfig.Type = { _tag: 'fhir-r4', rootUrl: '…', patientId: '…' }
```

`defaultConfig` seeds a fresh create-form, so make it a _valid_, harmless value
(the FHIR collector points at a public sandbox). Deriving arbitraries from the
schema keeps property tests in lockstep with validation — when the pattern
tightens, the generator narrows with it (see `config.test.ts`).

## 4. Scraping plan

`ScrapingPlan.make` (`collector-fundamentals/model`) declares _what_ to
recognize and _how_ to walk the source. It's a factory over config:

```ts
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> =>
  ScrapingPlan.make({
    name: 'FHIR R4',
    entityDefinitions: [PatientEntity, ObservationEntity, ObservationListEntity],
    firstPage: { _tag: 'Uri', uri: `${config.rootUrl}/Patient/${id}?_format=json` },
    stepSequence: [
      {
        _tag: 'Navigation',
        action: { _tag: 'Open', source: { _tag: 'Uri', uri: observationUrl } },
      },
    ],
    // maxGeneratedSteps / dedupeGeneratedOpenUris default to 500 / true.
  })
```

- **`firstPage`** is the `WebViewSource` (inline `Html` or absolute `Uri`) the
  sniffer webview mounts first.
- **`stepSequence`** is the _initial_ contents of the navigation queue — a list
  of `Step`s, each a `Navigation` or a `Delay`:
  - A **`Navigation`** step's `action` is forwarded to the sniffer verbatim: an
    `Open` navigates the host webview; a `PageAction` (`Click` / `Fill`,
    discriminated by inner `kind`) scripts an in-page interaction. It dispatches
    as soon as the machine reaches it, on the gating `PageLoaded` — there is no
    implicit settle delay. Its optional `advanceWhen` (`UrlMatch`) holds it until
    a `PageLoaded` whose `url` matches — use it for login redirects that settle at
    an unpredictable time. `advanceWhen` lives on the step wrapper, not the
    action, so it never leaks onto the wire. An empty `stepSequence` completes as
    soon as the first `PageLoaded`'s requests settle.
  - A **`Delay`** step (`{ _tag: 'Delay', duration }`) pauses the queue for
    `duration` before the next step. It never reaches the wire (the FSM consumes
    it as a timer). Add a **trailing** `Delay` when post-load XHR fan-out must
    start (and be tracked) before the queue drains and the run completes.
- **`maxGeneratedSteps`** (default 500) caps steps produced by `followUpSteps`,
  and **`dedupeGeneratedOpenUris`** (default `true`) drops a generated `Open`
  whose `Uri` was already visited (the `firstPage`, an authored `Open`, or an
  earlier generated `Open`). Together they terminate a naturally-recursive crawl;
  both are adjustable per-plan.

For the machines that consume the plan, see the
[Handler Explanation](../collector-fundamentals/docs/Handler%20Explanation.md).

## 5. Persist sink

`persistResources` is the descriptor's write seam. It **owns _how_ a batch is
written** — retries, per-resource spans, concurrency — and **must never fail**:
it returns the resources it couldn't write as `PersistFailure` data on a `never`
error channel, so one bad resource can't fail the whole run.

**Don't write one.** For a collector targeting the on-device FHIR R4 store —
every collector so far — import `fhir-r4`'s, which already owns all of the
above, and hand it to the descriptor:

```ts
import { persistResources } from 'fhir-r4/clients'
```

There is nothing per-collector to configure: the retry schedule, the
`WRITE_CONCURRENCY` bound, the failure accounting, and the telemetry are all
shared. The span it emits (`fhir.persist.write`, tagged `fhir.resource.type`) is
named in `fhir-r4`'s own catalog, because the write is `fhir-r4`'s — a collector
cannot make one write report itself as two different operations. That is also
why the sink declares its own `ResourceWriteFailure` rather than importing
`PersistFailure`: `fhir-r4` sits **below** this slice and cannot name it. The two
are checked against each other structurally when `CollectorDescriptor.make`
receives your sink, so a drift between them is a compile error here, not a silent
divergence.

The write requirement (`R`, here `FhirR4ResourcesHttpApiClient`) bubbles up as
the descriptor's `R`; app wiring provides that client layer, so the collector
slice never self-provides it. Only the resource type is sealed by the registry
(existential `Resources`) — `R` stays visible so the registry can surface it in
`CollectorRequirements`.

A collector targeting something _other_ than the FHIR store writes its own sink
to the same contract. Route "which resource → which endpoint" through that
target slice's reusable helper (FHIR's `upsertResource`), not an inline switch.

## 6. Provenance: store the source of every resource you produce

Every resource a collector produces was derived from a response, and that
response is discarded the moment `parse` settles. Wire the two seams below and
each one is kept as a trace `DocumentReference`, linked to the resources it
produced — so a resource that turns out to be wrong can be traced back to what
made it. This is **not** opt-in: the scope is bounded by what the plan actually
consumes, and that bound is what makes it always-on.

Copy `fhir-r4-client-collector/src/provenance.ts` — three small functions, and
the copy is deliberate (slice layering forbids one `*-client-collector`
importing another; the substance lives in `web-trace-core`). Add
`web-trace-core` to the package's `devDependencies` **and** `peerDependencies`,
then `vp install`.

```ts
const mintRunId = (): string => `my-collector-${globalThis.crypto.randomUUID()}`

const withProvenance =
  (sessionId: string) => (entity: EntityDefinition.EntityDefinition<FhirResource>) =>
    CapturedSource.withCapturedSource(entity, (response, produced) =>
      Effect.map(
        captureProvenance(
          {
            sessionId,
            requestId: response.id,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            startedAt: response.startedAt,
            // `bytes()`, never `text()` — see below.
            bytes: response.bytes(),
          },
          produced
        ),
        ({ linked, trace }) => [...linked, trace]
      )
    )

const isTraceResource = (resource: FhirResource): boolean =>
  resource.resourceType === 'DocumentReference' && isWebTrace(resource)
```

Then mint the run id **inside** the plan factory, wrap every entity with it, and
wrap the persist sink where the descriptor takes it (step 7):

```ts
const scrapingPlan = (config: InstanceConfig): ScrapingPlan.ScrapingPlan<FhirResource> => {
  const capture = withProvenance(mintRunId())
  return ScrapingPlan.make<FhirResource>({
    entityDefinitions: [capture(PatientEntity), capture(ObservationEntity)],
    …
  })
}

persistResources: DiagnosticResources.withDiagnosticResources(persistResources, isTraceResource)
```

Five things to get right:

- **Read the body with `response.bytes()`, never `text()`.** `text()` is UTF-8
  and lossy, so a re-encode of it is not the body that arrived and a hash over it
  means nothing. The trace stores the **raw** bytes — not the
  `extractJson`-unwrapped string your entity decoded.
- **`withCapturedSource` skips an empty parse.** A response that decoded to
  nothing is never captured; that rule is the line between provenance collection
  and bulk recording (a recorder is its own catch-all entity — see
  `web-trace-collector`). A failing or dying capture is WARN-logged and returns
  the inner resources unchanged, and `followUpSteps` still sees only the inner
  resources.
- **`withDiagnosticResources` is not optional.** A trace rides in the same batch
  as the clinical resources, and the runner folds _any_ `PersistFailure` into a
  `partial` import summary — so without the wrapper a failed trace write
  downgrades a clean run.
- **Don't test `resourceType === 'DocumentReference'` on its own.** A collector
  may one day produce a _clinical_ `DocumentReference`, and demoting that to a
  diagnostic would hide its failed write. `isWebTrace` is the category predicate
  the codec and the viewer both use.
- **The plan factory is now impure** — it mints a fresh run id per build, so the
  traces of one sync are grouped and a second sync cannot upsert over the first.
  `makeScrapingPlan` is called exactly once per run, so one build is one run.
  Consequence: a test comparing two plan builds must compare an identity
  _projection_ (name, `firstPage`, step names, entity names), not deep-equal
  them.

## 7. Descriptor + package index

`CollectorDescriptor.make` bundles the config schema, its default, the plan
factory, the display strings, and the persist sink into the one value the
registry consumes:

```ts
const FhirR4CollectorDescriptor = CollectorDescriptor.make({
  tag: 'fhir-r4',
  configSchema: InstanceConfig,
  defaultConfig,
  makeScrapingPlan: scrapingPlan,
  display: {
    title: 'FHIR R4', // the collector KIND's name
    description: 'Health records from a FHIR R4 server',
    listSubtitle: (config) => config.rootUrl, // per-instance detail
  },
  persistResources,
})
```

`make` adds the derived `resourcePersistenceRuntimeIfMatches` guard (how the
registry dispatches a stored config without an unsafe cast). Keep `display`
strings **kind-level** — a title like "Demo FHIR Server" names a _route's_ demo
entry, not the collector. Export the descriptor (and the form from step 9) from
the package `index.ts`.

## 8. Register in the registry

Add the package as a dependency of `collector-registry` and append the
descriptor to the closed tuple in `collector-registry/src/registry.ts`:

```ts
const descriptors = [FhirR4CollectorDescriptor, MyNewCollectorDescriptor] as const
```

That's the only edit here. `CollectorConfig`, `CollectorTag`,
`CollectorRequirements`, and `resourcePersistenceRuntimeForConfig` all re-derive
from the tuple — there is no parallel switch or union to update.

## 9. Write and register the config form

The form is written against the collector's own concrete config
(`ConfigFormProps<Config>` from `collector-fundamentals/config-form`). It owns
its fields and the submit boundary; the generic account screen injects the
shared chrome as `header` (type badge + account-name field) and `footer`
(Save/Cancel). Decode on submit and call `onSubmit` only with a valid config;
seed fields `initial` → `prefill` → `defaultConfig`:

```ts
function MyConfigForm({ initial, prefill, disabled, onSubmit, header, footer }: ConfigFormProps<MyConfig>) { … }
```

Then register it in the **closed** `tag → ConfigForm` map in
`collector-react/src/forms/config-form.tsx` (and add the client-collector as a
dependency of `collector-react`):

```ts
const configForms: { readonly [T in CollectorTag]: ConfigFormComponent<T> } = {
  'fhir-r4': FhirR4ConfigForm,
  'my-new': MyConfigForm,
}
```

The mapped type is the exhaustiveness lock: adding the descriptor in step 8
widens `CollectorTag`, and this record then **fails to compile** until the new
form is registered. That compile error is your reminder — you can't ship a
registered collector with no form.

## 10. Tests per layer

Changes must include tests (see [AGENTS.md](../../../AGENTS.md) and the
`/javascript-testing-expert` command). Cover each layer where it lives:

- **Config** — decode `defaultConfig`; round-trip `Arbitrary.make(InstanceConfig)`;
  reject malformed fields (table-driven).
- **Entities** — `isFoundAt` matches the right URLs and _rejects_ the
  neighbours (the disjointness that step 2's ordering depends on); `parse`
  decodes a fixture and drops unusable entries.
- **Scraping plan** — `firstPage` / `stepSequence` are the exact URLs
  (encoding, `?_format=json`, disjoint query patterns).
- **Descriptor** — `resourcePersistenceRuntimeIfMatches` matches its own configs
  and returns `undefined` for foreign ones; `display` strings.
- **Persist sink** — a failing write becomes one `PersistFailure`, not a run
  failure.
- **Provenance** — a response that produced a resource is captured with its body
  **verbatim** (base64 of the exact bytes, including a body that is not valid
  UTF-8 and one over the recorder's 1 MiB cap); a response that produced
  **nothing** is not captured at all, driven through the entity's real
  empty-parse path; both link directions round-trip through
  `fromDocumentReference`; a resource produced by two responses is named by both
  traces; and a failing trace write neither fails the run nor lands in its
  reported failures.
- **Form** — decodes valid input, renders a `ParseError` inline for bad input.

## 11. Regenerate the OpenAPI snapshots (the non-obvious ripple)

A new config **widens `CollectorConfig`**, which is the payload schema of
`CreateRemote` / `UpdateRemote`. That changes the collector remotes **wire
contract**, so the committed OpenAPI snapshot goes stale and the drift gate
(`api-sync` CI) fails until you regenerate it:

```bash
UPDATE_OPENAPI=1 cargo test -p collector-rust openapi_spec_snapshot_is_up_to_date
vp test openapi-drift
```

The Rust side declares `config` as an opaque wildcard
(`#[schema(value_type = Value)]`), so the _server_ spec doesn't move when a TS
collector is added — but the _client_ spec (`OpenApi.fromApi(CollectorApi)`)
does, and the TS drift test pins the two together. Details and gotchas:
[OpenAPI Spec Drift How-To](../../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

## 12. Verify

```bash
vp run ready   # fmt + lint + lint:comments + lint:docs + pack + test:all
```

`vp run ready` is the pre-PR gate. If Rust changed (it won't for a
TS-only collector beyond the regenerated snapshot), also run
`./scripts/checks/rust.sh`. Dry-run this checklist against your collector's
actual source: every step above should have a concrete edit, and nothing about
the target write API should require touching the runner or the registry dispatch.

## See also

- [slices/collector/AGENTS.md](../AGENTS.md) — package roles and guardrails.
- [Collector Sync Explanation](../collector-fundamentals/docs/Collector%20Sync%20Explanation.md)
  — the write seam (Context/Program/Runtime) and the drive loop.
- [Handler Explanation](../collector-fundamentals/docs/Handler%20Explanation.md)
  — the response tracker + automatic-navigation machine.
- [Documentation Reference](../../../docs/Documentation/Reference.md) — the
  four-kinds naming this doc follows.
