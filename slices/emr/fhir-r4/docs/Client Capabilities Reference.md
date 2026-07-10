# FHIR R4 Client Capabilities (gaps and gotchas)

This is an **internal scratch doc** — not a published FHIR `CapabilityStatement` resource, and **not a description of the server**. It catalogues the capabilities and gaps of the **`fhir-r4` TypeScript client** in `slices/emr/`: what its wire schemas validate and what its `HttpApi` description (and therefore the typed client) declares. Every entry is scoped to that client layer.

Server behaviour — validation, search, pagination, conformance — is **out of scope here**. The server is the off-the-shelf HFS Rust server embedded by `emr-rust` and mounted at `/fhir-r4`; it lives outside this slice's TypeScript surface and keeps no capability catalogue of its own (HFS implements standard FHIR R4). The client is hand-synchronized to what HFS serves — see "No drift guard against the HFS server" below.

Each entry is a place where the client deviates from, narrows, or postpones the FHIR R4 spec. None are blockers; they are simply not implemented in the client yet. When a deviation is fixed, delete or amend the entry. When a new gap is introduced (or noticed), add one.

## No drift guard against the HFS server

The `HttpApi` definition and the schemas here are hand-synchronized with what HFS actually serves at `/fhir-r4/*`. There is no OpenAPI-snapshot or CapabilityStatement-based drift test (deliberate, for now): `emr-rust` mounts HFS's router wholesale, so there is nothing to annotate with `utoipa` on the Rust side. If the two sides diverge, nothing fails automatically — changes to either side need a manual cross-check.

## Choice element XOR not enforced

FHIR R4 choice elements (`Patient.deceased[x]`, `Patient.multipleBirth[x]`, `Observation.value[x]`, `Observation.effective[x]`, `Extension.value[x]`, `MedicationRequest.medication[x]`, `MedicationRequest.reported[x]`, `MedicationRequest.substitution.allowed[x]`, `MedicationDispense.medication[x]`, `MedicationDispense.statusReason[x]`, `Dosage.asNeeded[x]`, `Dosage.doseAndRate.dose[x]`, `Dosage.doseAndRate.rate[x]`) are mutex by spec — only one variant may be set at a time. Our schemas declare every variant as an independent optional field (via `choiceElementSetPassthroughFields(prefix, variants)`, or — for the `Dosage.doseAndRate` `dose[x]`/`rate[x]` slots whose `SimpleQuantity` type is named `…Quantity` on the wire — as explicit `doseRange`/`doseQuantity`/`rateRatio`/`rateRange`/`rateQuantity` fields). A payload setting both `deceasedBoolean` and `deceasedDateTime`, or both `medicationCodeableConcept` and `medicationReference`, will validate.

FHIR also marks `MedicationRequest.medication[x]` and `MedicationDispense.medication[x]` as required (1..1); modeling every variant as an independent optional means neither is required at the schema level, so a payload with no medication slot set also validates.

We accept the loosening for now because we don't have a place to perform the cross-field refinement cheaply with `Schema.transformOrFail` without changing the Type. To enforce, add a `Schema.filter` on the relevant container struct that asserts at most one variant is set.

## Reference target-type enforcement (none)

Per FHIR R4 § Reference, every `Reference` element is constrained to specific target types — e.g. `Patient.managingOrganization → Reference(Organization)`, `Observation.subject → Reference(Patient|Group|Device|Location)`. We currently use a single shared `ReferenceSchema` for every reference field, so a payload putting `"reference": "Practitioner/123"` into `Patient.managingOrganization` validates.

To fix: parameterise `Reference` by allowed target types and apply a regex on `reference`. The shared schema also leaves `Reference.type` typed as plain `string` rather than `uri` because conventional FHIR values are bare resource type names ("Patient", "Practitioner") that don't parse as URLs. Identifier.system/Coding.system/Attachment.url are tightened to `Schema.URL` (always absolute URIs in the wild).

## Patient search parameters (subset declared)

Per FHIR R4 § Patient.search, the standard parameters include `_id`, `_lastUpdated`, `name`, `family`, `given`, `identifier`, `address`, `address-city/state/postalcode/country`, `telecom`, `email`, `phone`, `birthdate` (with date prefixes), `gender`, `active`, `deceased`, `general-practitioner`, `organization`, `link`. The `HttpApi` description (and therefore the typed client) declares only: `_count`, `_pageToken`, `gender`, `active`, `birthdate` (equality only — no date prefixes / partial-precision ranges). HFS may support more server-side, but the typed client can't express them.

Implication: SMART apps that search by name or MRN through the typed client will not work. Add `_id`, `name`, `family`, `given`, `identifier`, and date-prefixed `birthdate` for a baseline US Core / SMART experience.

## Observation search parameters (only paging declared)

Per FHIR R4 § Observation.search, the standard parameters include `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`, `date` (with prefixes), `status`, `category`, `identifier`, `performer`, `value-quantity`, `value-string`, `value-concept`, `code-value-quantity`, `component-code`, `component-value-quantity`, etc. The `HttpApi` description declares `_count` and `_pageToken` only.

Implication: the typed client cannot ask "latest blood pressure for this patient" — the primary reason to query Observation. Adding `subject`/`patient`/`code`/`category`/`date` would unlock the canonical workflows.

## MedicationRequest / MedicationDispense search parameters (only paging declared)

Per FHIR R4, `MedicationRequest.search` and `MedicationDispense.search` define parameters such as `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`/`context`, `status`, `intent` (request only), `authoredon` / `whenprepared` / `whenhandedover` (with date prefixes), `identifier`, `medication`, and `prescription` (dispense only). The `HttpApi` description declares `_count` and `_pageToken` only — same minimal paging surface as Observation. HFS indexes the full R4 parameter set server-side (e.g. `MedicationRequest.subject` feeds Patient `$everything`), but the typed client can't express those filters. Adding `subject`/`patient`/`code`/`status` would unlock the canonical medication workflows.

## `$everything` declared on every resource, served for Patient only

The `HttpApi` declares `GET /:resourceType/{id}/$everything` (with `_count`, returning a `Bundle`) on **every** resource group — it's added by `buildDomainResourceHttpApiGroup`, so the typed client will happily issue it for `Patient`, `Observation`, or `Binary`. The server only implements `Patient/{id}/$everything`; a `$everything` call on any other resource falls through to HFS, which has no such handler.

What the server actually returns for `Patient/{id}/$everything` — which related types it gathers, and how (an indexed, server-side, fully-paged `subject=` search per type) — is server behaviour and lives in the emr-rust [Capability Statement](../../emr-rust/docs/Capability%20Statement.md), not here.

## Patient invariant `pat-1` not enforced

FHIR R4 invariant `pat-1` on `Patient.contact` requires at least one of `name`, `telecom`, `address`, `organization` to be present. We do not enforce this; an empty contact backbone validates.

## Patient.communication / Patient.contact wire shape (fixed)

These are now serialized as "absent or non-empty array" matching every other `0..*` field on Patient (was previously `null` or array).

## Bundle entry sub-elements (typed)

`Bundle.entry.request`, `Bundle.entry.response`, `Bundle.entry.search`, `Bundle.entry.link`, and top-level `Bundle.link` are now typed as proper BackboneElement structs (`request.method` is the HTTP-verb enum, `search.mode` is `match|include|outcome`, etc.). `Bundle.signature` remains `Schema.Any`.

## Page tokens are opaque server state

`_pageToken` is declared as a plain string in every resource's `SearchParams`; the server (HFS) mints and interprets it. The client treats it as opaque and never constructs one.

## Binary inherits DomainResource (TODO)

Per FHIR R4 § Binary, the resource explicitly _does not_ extend `DomainResource` — it has no extensions, contained, or narrative. Today we extend `DomainResource.fields`, so a payload with a `text` (Narrative) on Binary will validate. Tracked separately; see GitHub issues.

## Unregistered choice-element datatypes (`value[x]` / `effective[x]`)

The fhir-r4 datatype registry (`slices/emr/fhir-r4/src/data-types/base/datatype-registry.ts`) ships wire schemas for a subset of FHIR R4 `Datatype.Name` — primitives (`boolean`, `canonical`, `date`, `dateTime`, `decimal`, `id`, `instant`, `integer`, `string`, `time`, `uri`, `url`) plus complex (`Address`, `Annotation`, `Attachment`, `CodeableConcept`, `Coding`, `ContactPoint`, `HumanName`, `Identifier`, `Meta`, `Period`, `Quantity`, `Range`, `Ratio`, `Reference`, `SampledData`, `SimpleQuantity`, `Timing`). Any `value[x]` or `effective[x]` slot whose datatype is **not** registered (e.g. `valueMoney`, `valueAge`, `valueDuration`, `valueSignature`, `valueDistance`, `valueCount`, `valueBase64Binary`, `valueCode`, `valueMarkdown`, `valueOid`, `valueUuid`, `valuePositiveInt`, `valueUnsignedInt`, …) behaves as follows on the wire:

- **Decode**: any wire content for an unregistered slot decodes to `null` (the slot exists at the type level so the in-memory shape still matches the decoded resource type).
- **Encode**: a non-null in-memory value at an unregistered slot **fails encoding** with a `ParseResult.Type` issue naming the unregistered datatype (`UnregisteredDatatype` tagged error in `datatype-registry.ts`). This is intentional — silent drops were the previous (pre-PR-#61) behavior and masked data loss.

`Timing.repeat.boundsDuration` is also unregistered. A `Duration` wire schema now ships (`data-types/complex/duration.ts`, used directly by `MedicationRequest.dispenseRequest`'s duration fields), but it deliberately does **not** register itself in the datatype registry — it only appears as a directly-named field, never through a `value[x]` / `bounds[x]` choice slot, and `Duration` is not part of the registry manifest (`baseDatatypes`). So `boundsDuration` stays unregistered; `Timing.repeat.boundsPeriod` and `Timing.repeat.boundsRange` round-trip.

To register a new datatype: add an entry to `baseDatatypes` in `datatype-registry.ts` and a `registerDatatypeSchema('Name', NameSchema)` line at the bottom of its datatype module file.

Note: a single collation block (e.g. inside `choice-element-passthrough-fields.ts` or `datatype-registry.ts` importing every `complex/*.ts` and calling `registerDatatypeSchema` for each) would be tidier, but is not viable today — it re-enters a partially-loaded `base/element.ts` through the Element ⇄ Extension cycle, spreading `undefined` for `Element.fields` into every complex datatype's struct at construction time. The per-module registration pattern avoids that hazard.

## Post-merge audit (TODO)

A handful of finer-grained spec audits — the `topLevel: true` collision on domain-resource groups, choice element XOR enforcement, Reference target-type enforcement, etc. — are tracked under the **Post Merge Audit** epic on GitHub.
