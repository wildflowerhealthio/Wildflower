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
  systems, and coding systems. **Reconciled against a real capture** — see
  [Extension Promotion](#extension-promotion) for the shape and its traps.
- `src/promote.ts` — the dialect post-step that moves carebook extensions into
  the conventional R4 fields that already exist for them.
- `src/bundle.ts` — the concrete carebook searchset Bundles (`MedicationRequestBundle`,
  `MedicationDispenseBundle`, mixed `MedicationBundle`), built by feeding the
  `fhir-stu3-as-r4/schemas` resource schemas through that slice's generic
  `Bundle.searchsetBundle` factory.

**2. the collector** (mirrors `fhir-r4-client-collector`; wired into
`collector-registry` + `collector-react`):

- `src/config.ts` — `InstanceConfig` (`{ _tag: 'rexall', email, password }`) with
  fast-check arbitraries, `defaultConfig`, the login-and-prescriptions
  `scrapingPlan`, and the `RexallCollectorDescriptor`.
- `src/response-kinds/profile-response-kind.ts` — recognizes `…/profile/v2/me` and synthesizes
  an R4 `Patient` from the (non-FHIR) carebook profile JSON.
- `src/response-kinds/medication-list-response-kind.ts` — recognizes the prescriptions page's
  `…/pharmacy/Location?…_revinclude=…` searchset and decodes the **heterogeneous**
  bundle "as is" (a `Schema.Union` of the two carebook `R4FromStu3Schema`
  transforms plus a `null` catch-all for non-medication entries), then splits off
  just `MedicationRequest` / `MedicationDispense`, dropping-and-counting the rest
  and running each survivor through `promote.ts`.
- the provenance hook — `web-trace-core`'s `makeFhirProvenanceCapture('rexall')`,
  one module-level line in `src/config.ts`, stated as the plan's
  `captureProvenance`.
- the persist sink — `fhir-r4`'s `persistResources`, imported in `src/config.ts`
  and handed straight to the descriptor.
- the source identity — `adoptSourceIdentity({ system: REXALL_CAREBOOK_SYSTEM })`
  wrapping the plan factory's return. It is what stops the request/dispense pair
  that shares a carebook id from collapsing onto one row. See the
  [Source Identity Explanation](../docs/Source%20Identity%20Explanation.md).
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

## Extension Promotion

The dialect is extension-heavy, and several of those extensions carry values R4
has a conventional field for. `src/promote.ts` moves them, running on the R4
output of the `fhir-stu3-as-r4` transform.

**It is deliberately a post-step in this package, not part of that transform.**
`R4FromStu3Schema` is bidirectional, and its encode side rejects by name most of
what gets written here (`category`, `doNotPerform`, `dispenseRequest.performer`,
`MedicationDispense.location`) because STU3 has no slot for them. Promoting
inside it would turn each promotion into a round-trip invariant on a slice whose
job is _generic_ STU3⇄R4. These are Rexall-specific readings of a vendor
dialect, so they live beside the rest of the carebook knowledge.

What moves (lift-and-drop — the extension is removed once the value lands):

| Extension                                               | Conventional home                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `medicationrequest/…/do-not-perform`                    | `MedicationRequest.doNotPerform` — an exact 1:1; the extension exists only because the source is STU3   |
| `medicationrequest/…/request-type` (`fill` \| `refill`) | `MedicationRequest.category` — `intent` is a constant `order` and carries no signal                     |
| `medicationrequest/…/medication-processor`              | `dispenseRequest.performer`                                                                             |
| `medicationdispense/…/medication-processor`             | `MedicationDispense.location`                                                                           |
| `medication/…/description`                              | the contained `Medication`'s narrative (`text.div`), **only when** it is absent or the `code.text` copy |
| `medication/…/strength`                                 | merged into `Medication.ingredient[0].strength`, **only when it parses** as `<number> <unit>`           |

The same contained-Medication promotions run on `MedicationDispense.contained`.
No dispense in the capture inlines a Medication, but the slot is identical, and
one that did would otherwise be stored differently from the same drug on the
request beside it.

Two things ride along, both fixing accuracy bugs rather than moving extensions:

- **The contained `Medication` is linked.** The dialect populates
  `medicationCodeableConcept` and leaves `contained[0]` unreferenced, so its
  `form`, `manufacturer`, strength and description are unreachable.
  `medicationReference: '#id'` replaces the inline concept (`medication[x]` is a
  choice, and the contained `code` is byte-identical to it) — **carrying the
  concept's label onto `Reference.display`**, so a reader that only renders
  `medication[x]` still has a name. A `medicationReference` already pointing
  somewhere that is not a `#fragment` is left alone: that is an external
  Medication, not an orphan to adopt.
- **Supply durations get their unit.** `dispenseRequest.expectedSupplyDuration`
  and `MedicationDispense.daysSupply` both arrive as a bare `{ value }`. They
  are days; the UCUM `d` is spelled out.

### Traps

- **A promotion that fails leaves its extension alone.** An unparseable
  strength, a value that will not decode, a contained Medication with no
  `code` (**including an explicit `"code": null` — `contained` is raw
  passthrough JSON, so nothing filters those upstream**), a
  `medication-processor` on a request that carries no `dispenseRequest` to hold
  it, a narrative already holding real content — each is a no-op, never a silent
  drop.
- **Extensions are consumed by array index, never by url.** The dialect writes
  several urls twice and `promote.ts` reads only the first, so dropping by url
  would delete a second copy nobody examined. Same reasoning inside a contained
  Medication, where each extension entry is decoded on its own: one malformed
  entry then disables only itself instead of switching off every promotion on
  the drug that carries it.
- **`parseStrength` takes `.` as the only decimal separator.** Rexall is an
  English-Canadian pharmacy, so `"1,000 mg"` is one thousand milligrams written
  with a thousands separator. Reading that comma as a decimal point would write
  a 1 mg strength and drop the extension holding the truth — a silent 1000×
  dosage error in the clinical record. The string simply fails to match instead.
- **The promoted narrative is XHTML, not the bare description.** R4 types
  `Narrative.div` as `xhtml` and requires a single `<div>` in the XHTML
  namespace; a conformant server rejects anything else on write. `promote.ts`
  wraps and escapes, and `medication-sponsorship-react` extracts the text
  content back out — the two are a pair.
- **`external-store-id` stays an extension on purpose.** `Reference.identifier`
  is 0..1 and the dialect already fills it on the processor reference with
  carebook's own pharmacy id; giving the store number that slot would discard a
  vendor identifier. `medication-sponsorship-react` reads it where it is to
  build the store-locator link.
- **The redundant extensions are kept, deliberately.** `when-requested` (equals
  `whenPrepared`), both `estimated-pick-up`s (equal `whenHandedOver`),
  `medicationrecord-processor` (byte-equal to `medication-processor`), the `v2`
  `number-of-repeats-available` (equals its `v1` sibling) and the
  `prescription-order` stub (`display: 'todo'`) are all redundant with something
  that already carries the value. Dropping them is a separate decision from
  promoting misplaced ones, so promotion leaves them.
- **`medication-processor-timezone` cannot be applied.** Every dialect timestamp
  arrives `+00:00` and this extension is their real offset, but both schemas
  type `dateTime` as `Schema.DateTimeUtc`, which normalizes to UTC on decode —
  so a pick-up at 20:09 local can render on the wrong day and there is nowhere
  for the offset to survive. Fixing it means changing the `dateTime` handling in
  `fhir-r4`, not this package.
- **`medication-sponsorship-react` reads this dialect too**, off the same
  decoded resources. It reads the description (**the extension first**, the
  narrative as the post-promotion fallback), the DIN, the `v2` repeats
  modifierExtension, and `external-system-source` + `external-store-id` for the
  store link. Changing what this package emits can break that view — check it.
  The read order is load-bearing in one direction only: exactly one of the two
  is present on a resource this package wrote, but a resource that has _not_
  been promoted (already in the store, or from the Medications app's own FHIR
  server) carries both, and its narrative is the dialect's byte-copy of
  `code.text` — i.e. the drug name the card already shows as its title.
  `medication-sponsorship-react` also keeps its own hand-maintained copy of five
  of these URLs plus `REXALL_SYSTEM_SOURCE`; the two catalogues are not shared
  because that slice does not depend on this one. Change one side, check the
  other.
- **`valuePositiveInt` used to decode to `null`.** `positiveInt` was not in
  `fhir-r4`'s datatype registry, so `sort-order` and the `v1`
  `number-of-repeats-available` were silently lost, and only the `v2`
  `valueDecimal` copy survived. It is registered now; the dual-write is why
  nobody noticed. It is registered **without** the spec's `> 0` refinement, and
  that is deliberate: carebook sends `valuePositiveInt: 0` for a prescription
  with no repeats left, and a refinement failure inside an extension fails the
  whole resource, which `medicationOrNull`'s catch-all turns into the
  MedicationRequest silently vanishing from the list. See the deviation note in
  [fhir-r4's Client Capabilities Reference](../../emr/fhir-r4/docs/Client%20Capabilities%20Reference.md).

## v1 scope: list-only

v1 ships **list-only** — no per-medication detail crawl. The prescriptions-page
searchset's `_revinclude` already carries `MedicationDispense`, so the deferred
`followUpSteps` crawl (one `Open` per `MedicationRequest.id` →
`…/prescriptions/details/{id}`) is left out until a capture diff proves the detail
XHR is richer. Adding it later is a pure, additive `followUpSteps` method on
`MedicationListResponseKind` — no structural change.

## Fixtures & open questions caveat

The `carebook.ts` constants and the **structure** of `src/fixtures/` are now
reconciled against a real (anonymized) `web-trace` capture of the prescriptions
page and the profile endpoint. The fixture _values_ are readable stand-ins; the
shapes, URLs and coding systems are the capture's. What that capture settled,
and what it did not:

**Settled.**

- **Every extension URL and coding system.** The shape is
  `{base}/{resource}/extension/{name}` with a `common/` namespace, not the flat
  `{base}/{name}` this package asserted before. `RequestType` is
  `fill | refill`, not `order | refill`. See `carebook.ts` for the two
  `schemas`/`schema` host spellings and which side each system falls on.
- **Profile field names.** `ProfileResponseKind` reads `data.identifiers.uid` /
  `data.identifiers.email` / `data.names.firstName` / `data.names.lastName` /
  `data.birthDate` / `data.zipPostalCode`. The name and postal-code paths are
  **not** flat — reading them as `data.firstName` / `data.address.postalCode`
  (which this package did) silently yields a nameless, address-less Patient,
  because the decode is lenient by design. Blank strings are treated as absent;
  the payload sends `""` for a name it has no value for.
- **The `_revinclude` parameters.** `MedicationRequest` /
  `MedicationDispense` / `DocumentReference` / `Immunization`, each on
  `extension.medicationrecord-processor`.

**Still open.**

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
  the deferred detail crawl is needed at all.
- **Whether the searchset really carries non-medication entries.** The capture's
  bundle held only `MedicationRequest` + `MedicationDispense` — no `Location`,
  `DocumentReference` or `Immunization` — despite `total: 91` against 12
  entries and all four `_revinclude`s being present. Whether the anonymizer
  stripped them or the server omits them is not determinable from that file, so
  the fixture keeps one of each and the entity keeps its drop-and-count path.

### Data-quality notes from the capture

Observed, not acted on — worth knowing before trusting a field:

- A `MedicationRequest` and its `MedicationDispense` **share the same `id`** and
  the same identifier pair. Anything keying on id alone rather than
  (resourceType, id) collapses the two — which is why the plan is wrapped in
  `adoptSourceIdentity`, whose derivation takes the resource type as an input.
- `authorizingPrescription[].reference` does **not** resolve to any bundle
  entry; the working link is `identifier.value`. The two entries are the same
  reference twice, differing only in `identifier.system` (`…-type-order` /
  `…-type-refill`).
- `whenPrepared` / `whenHandedOver` are byte-equal to the `when-requested` /
  `estimated-pick-up` extensions — so for a `completed` dispense,
  `whenHandedOver` may be an _estimate_, not an actual hand-over.
- `note[0].text` is the **sig** (`"TAKE 1 TABLET (=20MG) BY MOUTH ONCE DAILY"`),
  not an annotation. Its conventional home is `dosageInstruction[0].text`; it is
  left in `note` for now.
- `requester.agent.reference` and `subject.display` arrive as empty strings
  where the field should simply be absent.

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
