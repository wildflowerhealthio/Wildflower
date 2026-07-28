# AGENTS.md — slices/collector/fhir-r4-client-collector

The **FHIR R4 collector**: point it at a FHIR R4 server and a patient id, and it
pulls that patient plus their observations into the on-device FHIR R4 store. It
is the worked example the rest of the slice is modelled on — the simplest
possible collector, because the source already speaks the target's language, so
its entities decode rather than translate.

Every response one of its entities derives a resource from is also kept, byte
for byte, as a trace `DocumentReference` — see [Provenance](#provenance) below.

## Shape

An ordinary `*-client-collector` (`rexall-be-well-collector` and
`web-trace-collector` mirror this layout):

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'fhir-r4', rootUrl, patientId }`)
  with fast-check arbitraries, `defaultConfig` (the public SMART Health IT
  sandbox), the two-page `scrapingPlan`, and the `FhirR4CollectorDescriptor`.
- `src/entities/patient-entity.ts` — `…/Patient/<id>` → one R4 `Patient`.
- `src/entities/observation-entity.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/entities/observation-list-entity.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('fhir-r4')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (copied verbatim in
  `rexall-be-well-collector`; slice layering forbids importing it).
- `src/fhir-r4-config-form.tsx` (+ `.module.css`) — the rootUrl/patientId
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel the registry and the React adapter import from.

## The plan

`firstPage` navigates the sniffer webview **directly to the FHIR JSON endpoint**
(`…/Patient/:id?_format=json`) rather than to a page that fetches it: the
browser's native JSON viewer renders the response, the sniffer snapshots the
document, and `extractJson` unwraps the `<pre>` before the entity decodes. Then
one `Open` step navigates to `…/Observation?subject%3APatient=…`, followed by an
`AwaitPageSettled` hold — a `Navigation` dispatches and advances immediately, so
without that hold the queue would drain before the Observation request is even
tracked.

## Provenance

The plan states one hook: `captureProvenance: makeFhirProvenanceCapture('fhir-r4')`
(module-level, so two plans from one config deep-equal). The framework does the
rest — it mints the run id at dispatch, invokes the hook only for a response
whose parse produced resources, and persists the resulting trace best-effort on
the batch's `diagnostics` channel. A non-empty parse therefore yields the
decoded resources each carrying `meta.source` back to the trace, plus one trace
`DocumentReference` naming all of them in `context.related`. The encoding and
both link directions live in `web-trace-core`; this package only names itself.

- **The body is read with `response.bytes()`, never `text()`.** `text()` is UTF-8
  and lossy — a body that is not valid UTF-8 comes back peppered with U+FFFD, and
  a re-encode of that string is not what arrived, which would make the stored
  hash meaningless.
- **The trace stores the _raw_ bytes, not the `extractJson`-unwrapped string the
  entity decoded.** A payload served through the WebView's JSON viewer is stored
  as the HTML that arrived, because that is what the provenance actually was.
- **Verbatim: no allowlist, no truncation.** `web-trace-collector`'s content-type
  allowlist and 1 MiB cap are a _recording_ policy; a body that justifies a
  specific clinical resource _is_ the provenance, so storing its size and hash
  with no data would defeat the point.

## Traps

- **`scrapingPlan` is `(config, runId) => plan` and deterministic given its
  inputs.** The framework mints the run id at dispatch (one per
  `resourcePersistenceRuntimeIfMatches` call, so one plan build is one run);
  this factory ignores the parameter — the hook receives the id at invocation.
  The trace resource id is `{fhir-r4-runId}-{requestId}`, which is why the id
  must be fresh per run: a config-derived id would make a second sync silently
  upsert its traces over the first's. Tests deep-equal plans built with a
  fixed run id.
- **A response that produced no resource is not captured.** The tracker skips
  the hook on an empty parse, which is the line between provenance collection
  and bulk recording. `PatientEntity` returns `[]` for a patient with a null id
  and `ObservationListEntity` returns `[]` for a bundle with no usable
  entries — those responses leave no trace, by design.
- **A trace must never degrade the primary output.** A failing or dying hook is
  WARN-logged by the tracker and the entity's own resources flow on unchanged;
  a failing trace _write_ is WARN-logged by the runner and kept out of the
  run's reported failures — the trace rides the `diagnostics` channel, so the
  separation is structural, not a predicate. If an existing entity suite's
  expectations have to change to accommodate provenance, something has gone
  wrong — the wiring only adds `meta.source` and a separate diagnostic.
- **`entityDefinitions` order is not load-bearing here, and should stay that
  way.** `mustHaveQuery` on the Observation-list pattern keeps it disjoint from
  the single-`Observation` pattern; without it the first `isFoundAt` match would
  silently win.
- **`patientId` is `encodeURIComponent`-ed even though the schema already
  constrains it** to the FHIR R4 logical-id grammar — defence for a value that
  reaches the factory through an untyped path. `config.test.ts` pins that the
  encoding actually happens.
- **`extractJson` is a copy, not an import.** Fixing a bug in one copy means
  fixing it in `rexall-be-well-collector` too.

## Registration

Two static edits, per the descriptor seam:

- `collector-registry/src/registry.ts` — in the `descriptors` tuple.
- `collector-react/src/forms/config-form.tsx` — `'fhir-r4': FhirR4ConfigForm` in
  the closed `configForms` map.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector is the worked example for, including the provenance step.
- [slices/collector/AGENTS.md](../AGENTS.md) — package roles, the
  `captureProvenance` / diagnostics-channel guardrails, and the
  plan-purity trap in full.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the
  codec and the two body policies the provenance capture picks between.
- [fhir-r4](../../emr/fhir-r4) — the R4 resource schemas and the
  `persistResources` / `upsertResource` write path.
- [rexall-be-well-collector](../rexall-be-well-collector/AGENTS.md) — the other
  production collector, which mirrors this layout and states the same one-line
  provenance hook.
