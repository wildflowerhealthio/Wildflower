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
  The plan's `responseKinds` are `fhir-r4-source`'s `fhirR4ResponseKinds`
  consumed **directly** — the same pre-adopted definition the archive importer
  runs, so live and archive are reference identity and cannot disagree. The
  response kinds live in that package, the **source package** this collector
  builds its live plan from. See
  [fhir-r4-source AGENTS.md](../../http-extraction/fhir-r4-source/AGENTS.md).
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('fhir-r4')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- the source identity — nothing to wire here: `fhirR4ResponseKinds` is already
  adopted (`adoptUnderRecognizedRoot`), so each resource keys under the root of
  the URL it arrived on, minted by each kind's own `tryRecognize`
  (`recognizeFhirRoot` → `{ system: root, baseUrl: root }`). See
  [live keying](#live-keying-is-per-response) and the
  [Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).
- `src/fhir-r4-config-form.tsx` (+ `.module.css`) — the rootUrl/patientId
  `ConfigFormProps` form `collector-react` registers.
- `src/source-parity.test.ts` — pins that a resource captured from its
  configured root carries the byte-identical id through the live plan and
  through the source's entities (the tests that need
  `InstanceConfig`/`scrapingPlan`; the source's own behaviour is
  pinned in `fhir-r4-source`).
- `src/index.ts` — the barrel the registry and the React adapter import from.

## The plan

The plan's first `Open` step brings the sniffer up
**directly on the FHIR JSON endpoint** (`…/Patient/:id?_format=json`) rather than
to a page that fetches it: the browser's native JSON viewer renders the response,
the sniffer snapshots the document, and `extractJson` unwraps the `<pre>` before
the entity decodes. A pattern-less `AwaitPageSettled` holds until that page
settles, then a second `Open` step navigates to `…/Observation?subject%3APatient=…`,
followed by another pattern-less `AwaitPageSettled` — a `Navigation` dispatches
and advances immediately, so without each hold the queue would drain before the
request is even tracked. The holds are pattern-less because each `Open` targets a
fresh document, so "wait for the next settle" is unambiguous.

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

## Source surface

Lives in [`fhir-r4-source`](../../http-extraction/fhir-r4-source/AGENTS.md)
(`slices/http-extraction`), together with the response kinds: each kind's
`tryRecognize` (built from `recognizeFhirRoot`) claims a FHIR URL at
`Specificity.PROTOCOL` and mints `{ system: root, baseUrl: root }` from the
matcher's own capture, and `fhirR4ResponseKinds` is that kind tuple pre-adopted.
The live plan here consumes `fhirR4ResponseKinds` **directly** — the same
single, already-adopted array the archive importer runs — so a resource decodes
_and_ keys identically through the sniffer and through an archive, by reference.
`source-parity.test.ts` in this package pins the surviving load-bearing property:
`tryRecognize(${config.rootUrl}/Patient/…).source.{system,baseUrl} ===
config.rootUrl` for a capture from the configured server.

### Live keying is per-response

FHIR keying derives from each response's **own URL root**, not `config.rootUrl`.
For an ordinary same-server capture the two coincide, byte for byte. **Caveat:** a
FHIR endpoint that redirects **cross-origin or cross-basepath** — the sniffer pins
`response.url` at `ResponseStart`, so the derived root becomes the redirect
target, where config-constant keying would have used `config.rootUrl`. Accepted:
keying under a resource's own URL is what lets a two-server capture separate
cleanly, and `config.rootUrl` keeps only its navigation role (the plan's `Open`
steps still target `${config.rootUrl}/Patient/…`).

## Traps

- **`scrapingPlan` is `(config, runId) => plan` and deterministic given its
  inputs.** The framework mints the run id at dispatch (one per
  `resourcePersistenceRuntimeIfMatches` call, so one plan build is one run);
  this factory ignores the parameter — the hook receives the id at invocation.
  The trace resource id is derived from `(fhir-r4-runId, requestId)`, which is
  why the run id must be fresh per run: a config-derived one would make a second
  sync silently upsert its traces over the first's. Tests deep-equal plans built with a
  fixed run id.
- **A response that produced no resource is not captured.** The tracker skips
  the hook on an empty parse, which is the line between provenance collection
  and bulk recording. `PatientResponseKind` returns `[]` for a patient with a null id
  and `ObservationListResponseKind` returns `[]` for a bundle with no usable
  entries — those responses leave no trace, by design.
- **A trace must never degrade the primary output.** A failing or dying hook is
  WARN-logged by the tracker and the entity's own resources flow on unchanged;
  a failing trace _write_ is WARN-logged by the runner and kept out of the
  run's reported failures — the trace rides the `diagnostics` channel, so the
  separation is structural, not a predicate. If an existing entity suite's
  expectations have to change to accommodate provenance, something has gone
  wrong — the wiring only adds `meta.source` and a separate diagnostic.
- **`responseKinds` order is not load-bearing here, and should stay that
  way.** `mustHaveQuery` on the Observation-list pattern keeps it disjoint from
  the single-`Observation` pattern; without it the two would tie on specificity
  and routing would fall back to list order, silently shadowing the narrower.
- **`patientId` is `encodeURIComponent`-ed even though the schema already
  constrains it** to the FHIR R4 logical-id grammar — defence for a value that
  reaches the factory through an untyped path. `config.test.ts` pins that the
  encoding actually happens.

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
