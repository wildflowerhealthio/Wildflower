# AGENTS.md — slices/collector/rexall-be-well-collector

The **Rexall Be Well collector**: logs into Rexall's `letsbewell.ca` portal and
pulls the user's prescriptions into the on-device FHIR **R4** store. The carebook
STU3 dialect, response kinds, and source descriptor live in
[`rexall-be-well-source`](../../http-extraction/rexall-be-well-source/AGENTS.md)
(in `slices/http-extraction/`); this package layers navigation, provenance, and
persistence on top, mirroring `fhir-r4-client-collector`. The generic STU3⇄R4
schema machinery lives in `slices/emr/fhir-stu3-as-r4`.

The carebook dialect this collector decodes with — extension promotion, the
capture fixtures, the coding-system constants, and the data-quality notes — is
documented beside its code in that source package. This file covers only the
collector: the login-and-scrape plan, provenance, and persistence. Adoption keys
the request/dispense pair (which share a carebook id) apart under
`REXALL_CAREBOOK_SYSTEM`; see the
[Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).

## Shape

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'rexall', email, password }`) with
  fast-check arbitraries, `defaultConfig`, the login-and-prescriptions
  `scrapingPlan`, and the `RexallCollectorDescriptor`. The response kinds come
  from `rexallBeWellSource.responseKinds` (pre-adopted in the source package).
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('rexall')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- `src/rexall-config-form.tsx` (+ `.module.css`) — the email/password
  `ConfigFormProps` form `collector-react` registers.
- `src/index.ts` — the barrel re-exporting config and form.

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
  The trace resource id is derived from `(rexall-runId, requestId)`, which is
  why the run id must be fresh per run: a config-derived one would make a second
  sync of the same account silently upsert its traces over the first's. Tests deep-equal
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
`MedicationListResponseKind` (in the source package) — no structural change here.

## Open questions

The anonymized capture covers only the post-login XHRs, so the login half of
`config.ts`'s scraping plan carries best-guess defaults, and one scope question
stays open:

- **Login-form selectors** — `config.ts`'s `EMAIL_SELECTOR` / `PASSWORD_SELECTOR`
  / `SUBMIT_SELECTOR` are best-guess defaults for `verify.letsbewell.ca/login`.
  The capture covers only the post-login XHRs.
- **Login-page settle** — the leading `AwaitPageSettled`
  (`continueOnTimeout: true`) between the `Open` and the 2 s `Delay` assumes the
  sign-in page surfaces a settled `PageLoaded`. Without it the `Delay`
  would run _concurrently with_ the login page's network load rather than after
  it, and any load slower than 2 s left the `Fill` selectors matching nothing. The
  `Delay` is kept alongside it — settlement means "quiet DOM, no in-flight XHR",
  which an SPA can reach before the login form has rendered (see #339).
- **Login transition** — the `AwaitPageSettled` hold after the submit `Click`
  assumes the post-login jump to `app.letsbewell.ca` surfaces a settled
  `PageLoaded` (a hard cross-host redirect, or an SPA route the sniffer's settle
  watch still reports). Falls back to a fixed `Delay` if it bites (see the sniffer
  caveat on issue #339).
- **Detail XHR richness** — the list-vs-detail capture diff that decides whether
  the deferred detail crawl (see [v1 scope](#v1-scope-list-only)) is worth
  adding. The dialect-shape questions — including whether the searchset really
  carries non-medication entries — are documented with the source package.

## References

- [rexall-be-well-source](../../http-extraction/rexall-be-well-source/AGENTS.md)
  — the carebook dialect, response kinds, and source descriptor this collector
  consumes
- [Adding a Collector How-To](../docs/Adding%20a%20Collector%20How-To.md) — the
  recipe this collector follows, including the provenance step
- [fhir-r4-client-collector](../fhir-r4-client-collector/AGENTS.md) — the worked
  example mirrored
- [web-trace-core](../../web-trace/web-trace-core/AGENTS.md) — the codec and the
  two body policies the provenance capture picks between
- [fhir-stu3-as-r4](../../emr/fhir-stu3-as-r4) — the STU3⇄R4 schemas the bundles decode with
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types and the `upsertResource` write path
- [collector-fundamentals](../collector-fundamentals) — the descriptor / entity / plan primitives
