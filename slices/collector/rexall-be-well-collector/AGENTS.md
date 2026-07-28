# AGENTS.md — slices/collector/rexall-be-well-collector

The **Rexall Be Well collector**: logs into Rexall's `letsbewell.ca` portal and
pulls the user's prescriptions into the on-device FHIR **R4** store. The Rexall
tunnel API (`rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/…`)
serves FHIR **STU3** searchset Bundles in a narrow, extension-heavy carebook
dialect; this package holds everything Rexall/carebook-specific, from the dialect
constants up to the registered `CollectorDescriptor`. The generic STU3⇄R4 schema
machinery lives in `slices/emr/fhir-stu3-as-r4`.

## Two layers

**1. carebook dialect** (the original scope of this package):

- `src/carebook.ts` — the dialect catalogue: carebook extension URLs, identifier
  systems, and the DIN coding system.
- `src/bundle.ts` — the concrete carebook searchset Bundles (`MedicationRequestBundle`,
  `MedicationDispenseBundle`, mixed `MedicationBundle`), built by feeding the
  `fhir-stu3-as-r4/schemas` resource schemas through that slice's generic
  `Bundle.searchsetBundle` factory.

**2. the collector** (mirrors `fhir-r4-client-collector`; wired into
`collector-registry` + `collector-react`):

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'rexall', email, password }`) with
  fast-check arbitraries, `defaultConfig`, the login-and-prescriptions
  `scrapingPlan`, and the `RexallCollectorDescriptor`.
- `src/entities/profile-entity.ts` — recognizes `…/profile/v2/me` and synthesizes
  an R4 `Patient` from the (non-FHIR) carebook profile JSON.
- `src/entities/medication-list-entity.ts` — recognizes the prescriptions page's
  `…/pharmacy/Location?…_revinclude=…` searchset and decodes the **heterogeneous**
  bundle "as is" (a `Schema.Union` of the two carebook `R4FromStu3Schema`
  transforms plus a `null` catch-all for non-medication entries), then splits off
  just `MedicationRequest` / `MedicationDispense`, dropping-and-counting the rest.
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('rexall')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer (a copy of
  `fhir-r4-client-collector`'s; slice layering forbids importing it).
- `src/rexall-config-form.tsx` (+ `.module.css`) — the email/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel re-exporting both layers.

Only user-facing `letsbewell.ca` pages are ever navigated (the login page, then
the prescriptions page); the collector only **sniffs** the XHRs those pages fire.
**No tunnel/API URL is ever crafted or opened directly** — those requests need
auth/bearer headers the Angular SPA injects, and crafting them is an explicit
product constraint.

## Provenance

The plan states one hook: `captureProvenance: makeFhirProvenanceCapture('rexall')`
(module-level, so two plans from one config deep-equal). The framework does the
rest — it mints the run id at dispatch, invokes the hook only for a response
whose parse produced resources, and persists the resulting trace best-effort on
the batch's `diagnostics` channel. A non-empty parse therefore yields the
decoded resources each carrying `meta.source` back to the trace, plus one trace
`DocumentReference` naming all of them in `context.related`. The encoding and
both link directions live in `web-trace-core`; this package only names itself.

It matters more here than for `fhir-r4-client-collector`, because this collector
**translates**: a `MedicationRequest` is the output of a carebook STU3 → R4
transform, and a `Patient` is _synthesized_ from a bespoke non-FHIR profile
payload. The trace is the only record of what the transform was actually given.

- **The body is read with `response.bytes()`, never `text()`.** `text()` is UTF-8
  and lossy — a body that is not valid UTF-8 comes back peppered with U+FFFD, and
  a re-encode of that string is not what arrived, which would make the stored hash
  meaningless.
- **The trace stores the _raw_ carebook payload**, not the
  `extractJson`-unwrapped string the entity decoded and not the R4 resource it
  became.
- **Verbatim: no allowlist, no truncation.** `web-trace-collector`'s content-type
  allowlist and 1 MiB cap are a _recording_ policy; a body that justifies a
  specific clinical resource _is_ the provenance.

### Traps

- **`scrapingPlan` is `(config, runId) => plan` and deterministic given its
  inputs.** The framework mints the run id at dispatch (one per
  `resourcePersistenceRuntimeIfMatches` call, so one plan build is one run);
  this factory ignores the parameter — the hook receives the id at invocation.
  The trace resource id is `{rexall-runId}-{requestId}`, which is why the id
  must be fresh per run: a config-derived id would make a second sync of the
  same account silently upsert its traces over the first's. Tests deep-equal
  plans built with a fixed run id.
- **A response that produced no resource is not captured.** The tracker skips
  the hook on an empty parse — the line between provenance collection and bulk
  recording. A searchset whose entries are all `Location` / `DocumentReference` /
  `Immunization` decodes fine and yields nothing, so it leaves no trace, by
  design. (The carebook searchset's clinical `DocumentReference` entries are
  also why the diagnostic split being _structural_ matters: a clinical
  `DocumentReference` in `resources` keeps its failure accounting; only the
  hook-minted trace rides `diagnostics`.)
- **A trace must never degrade the primary output.** A failing or dying hook is
  WARN-logged by the tracker and the entities' own resources flow on
  unchanged; a failing trace _write_ is WARN-logged by the runner and kept out
  of the run's reported failures. If an existing entity suite's expectations
  have to change to accommodate provenance, something has gone wrong — the
  wiring only adds `meta.source` and a separate diagnostic.

## v1 scope: list-only

v1 ships **list-only** — no per-medication detail crawl. The prescriptions-page
searchset's `_revinclude` already carries `MedicationDispense`, so the deferred
`followUpSteps` crawl (one `Open` per `MedicationRequest.id` →
`…/prescriptions/details/{id}`) is left out until a capture diff proves the detail
XHR is richer. Adding it later is a pure, additive `followUpSteps` method on
`MedicationListEntity` — no structural change.

## Fixtures & open questions caveat

The fixtures in `src/fixtures/` and the `carebook.ts` constants are **synthesized
from the epic's dialect notes, not real captured payloads**. `prescriptions-searchset.json`
(the heterogeneous list bundle) and `profile-me.json` (the carebook profile) are
built to the shapes the epic describes. Validate them — and reconcile these
**open questions** — against redacted real captures before relying on the
collector end-to-end:

- **Login-form selectors** — `config.ts`'s `EMAIL_SELECTOR` / `PASSWORD_SELECTOR`
  / `SUBMIT_SELECTOR` are best-guess defaults for `verify.letsbewell.ca/login`.
- **Login transition** — the `AwaitPageSettled` hold after the submit `Click`
  assumes the post-login jump to `app.letsbewell.ca` surfaces a settled
  `PageLoaded` (a hard cross-host redirect, or an SPA route the sniffer's settle
  watch still reports). Falls back to a fixed `Delay` if it bites (see the sniffer
  caveat on issue #339).
- **Profile field names** — reconciled against production: `ProfileEntity`'s
  `ProfileSchema` reads the `/me` payload's top-level `data` envelope
  (`data.identifiers.uid` / `data.identifiers.email` / `data.firstName` /
  `data.lastName` / `data.birthDate` / `data.address.postalCode`), and
  `profile-me.json` mirrors that shape. Decode stays lenient — a field the
  capture omits simply won't populate its Patient slot (it never fails the
  decode).
- **Detail XHR richness** — the list-vs-detail capture diff that decides whether
  the deferred detail crawl is needed at all.

## References

- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows, including the provenance step
- [fhir-r4-client-collector](../fhir-r4-client-collector/AGENTS.md) — the worked
  example mirrored, and the source of the duplicated `provenance.ts` /
  `extract-json.ts`
- [web-trace-core](../../web-trace/web-trace-core/AGENTS.md) — the codec and the
  two body policies the provenance capture picks between
- [fhir-stu3-as-r4](../../emr/fhir-stu3-as-r4) — the STU3⇄R4 schemas the bundles decode with
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
