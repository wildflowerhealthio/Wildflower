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

## `Observation.status` defaulted to `unknown` when absent

FHIR R4 marks `Observation.status` as required (1..1). Real servers — notably HAPI's public sandbox — nonetheless return hand-entered Observations that omit it, and in a search `Bundle` a single such entry would otherwise fail the decode of the **entire page** (`Bundle.Schema(Observation.Schema)` types `entry.resource` as `Observation | undefined`, so a status-less resource matches neither arm). The client therefore models `status` as `Schema.optionalWith(StatusSchema, { default: () => 'unknown' })`: a **missing/undefined** status decodes to FHIR's own `unknown` sentinel, so the resource (and its Bundle page) survives.

This rescues **absence only**. A status that is present but not a valid code — an unrecognized string, or `null` — still fails decode with a `ParseError`; a bad value is never coerced.

Consequence on the types: because accepting a missing status on decode and the declared Encoded (wire) type are the same side, the schema's Encoded type now marks `status` **optional** (reflected in the `ObservationSchema` annotation, which `Omit`s `status` from `FhirR4.Observation` and re-adds it optional). The **published** contract is unchanged, though: the hand-written `observationJsonSchema` annotation still lists `status` in `required`, and it — not the derived struct — drives the OpenAPI snapshot, so the OpenAPI/drift guard sees no change.

## Medication resource (just-enough, added for the STU3 → R4 bridge)

`Medication` is modeled with its standard R4 fields (`code`, `status`,
`manufacturer`, `form`, `amount`, `ingredient[]`, `batch`) plus the
`DomainResource` extension array, primarily to give `fhir-stu3-as-r4`'s
STU3→R4 transforms a real R4 target. As with every resource here,
`Medication.ingredient.item[x]` (CodeableConcept | Reference) is two independent
optional fields, not an enforced XOR. A `Medication.empty` all-absent default is
exported (alongside `.empty` on `MedicationRequest` / `MedicationDispense` /
`MedicationRequestDispenseRequest` and `IdentifierAndReference.emptyReference`)
for transforms that overlay populated fields onto it. `Quantity.fromSimpleQuantity`
widens a `SimpleQuantity` to a full `Quantity` (brands `code`, adds a null
`comparator`) for the same transforms.

## Reference target-type enforcement (none)

Per FHIR R4 § Reference, every `Reference` element is constrained to specific target types — e.g. `Patient.managingOrganization → Reference(Organization)`, `Observation.subject → Reference(Patient|Group|Device|Location)`. We currently use a single shared `ReferenceSchema` for every reference field, so a payload putting `"reference": "Practitioner/123"` into `Patient.managingOrganization` validates.

To fix: parameterise `Reference` by allowed target types and apply a regex on `reference`. The shared schema also leaves `Reference.type` typed as plain `string` rather than `uri` because conventional FHIR values are bare resource type names ("Patient", "Practitioner") that don't parse as URLs. Identifier.system/Coding.system/Attachment.url are tightened to `Schema.URL` (always absolute URIs in the wild).

## Patient search parameters (subset declared)

Per FHIR R4 § Patient.search, the standard parameters include `_id`, `_lastUpdated`, `name`, `family`, `given`, `identifier`, `address`, `address-city/state/postalcode/country`, `telecom`, `email`, `phone`, `birthdate` (with date prefixes), `gender`, `active`, `deceased`, `general-practitioner`, `organization`, `link`. The `HttpApi` description (and therefore the typed client) declares only: `_count`, `_pageToken`, `gender`, `active`, `birthdate` (the shared `DateSearchParam` value — see "Date search parameter modelling" below). HFS may support more server-side, but the typed client can't express them.

Implication: SMART apps that search by name or MRN through the typed client will not work. Add `_id`, `name`, `family`, `given`, and `identifier` for a baseline US Core / SMART experience (`birthdate` already carries date prefixes via `DateSearchParam`).

## Observation search parameters (only paging declared)

Per FHIR R4 § Observation.search, the standard parameters include `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`, `date` (with prefixes), `status`, `category`, `identifier`, `performer`, `value-quantity`, `value-string`, `value-concept`, `code-value-quantity`, `component-code`, `component-value-quantity`, etc. The `HttpApi` description declares `_count` and `_pageToken` only.

Implication: the typed client cannot ask "latest blood pressure for this patient" — the primary reason to query Observation. Adding `subject`/`patient`/`code`/`category`/`date` would unlock the canonical workflows.

## DocumentReference search parameters (subset declared)

Per FHIR R4 § DocumentReference.search, the standard parameters include `_id`, `_lastUpdated`, `patient`, `subject`, `type`, `category`, `status`, `date`, `period`, `author`, `custodian`, `encounter`, `facility`, `setting`, `identifier`, `relatesto`, `relation`, `security-label`, `format`, `contenttype`, `language`, `location`, etc. The `HttpApi` description (and therefore the typed client) declares: `_count`, `_pageToken`, `_id`, `identifier`, `category`, `type`, `status`, `date`.

`status` is narrowed to the `DocumentReference.status` value set (`current | superseded | entered-in-error`), so an out-of-set code fails to typecheck. `date` is the shared **`DateSearchParam`** value (see "Date search parameter modelling" below).

Two narrowings remain:

- **No reference-typed parameters.** `patient`, `subject`, `author`, `custodian`, `encounter` are not declared, so the client still cannot ask "the discharge summaries for **this patient**" in one query — it filters by `category`/`type` and reads `subject` off the returned resources.
- **Single value per parameter.** Every `SearchParams` struct in this package is a flat one-value-per-key record, so FHIR's comma-separated OR (`category=a,b`) and repeated-key AND are not modelled.

HFS may support more server-side, but the typed client can't express them — and, per "No drift guard against the HFS server" above, nothing verifies that HFS honours the parameters declared here. That pairing stays hand-checked.

## Date search parameter modelling

`date`-typed search parameters (`DocumentReference.date`, `Patient.birthdate`) share one schema, `DateSearchParam` (`resources/search/date-search-param.ts`), rather than each declaring an ad-hoc string or a bare `DateTime.Utc`. Per FHIR R4 § search.html#date, a `date` search value targets resource elements of type `date`, `dateTime`, `instant`, `Period`, or `Timing`, and a date search is **intrinsically a match against a period** — whatever the precision of the value, and whatever the type of the element it is compared to.

The schema models exactly that. Every value — prefixed or not, complete or partial — decodes to one shape:

```ts
{
  prefix: Prefix
  value: string
  lowerBound: DateTime.Utc
  upperBound: DateTime.Utc
}
```

- `prefix` is the comparison (`eq`/`ne`/`gt`/`lt`/`ge`/`le`/`sa`/`eb`/`ap`), accepted at **any** precision — `ge2026` means "on or after the start of 2026", as the spec intends.
- `value` is the literal exactly as authored, so no precision is invented on the wire: `date=2026-07` is sent as `2026-07`, leaving the server its own range interpretation.
- `lowerBound`/`upperBound` are the period the literal denotes, filled per the spec's rule — the lower bound takes the lowest possible value of every unspecified level (first month, first day, zero-filled time), the upper bound the highest (last month, last day _allowing for leap years_, `23:59:59.999`). So `2026-07` bounds `[2026-07-01T00:00:00.000Z, 2026-07-31T23:59:59.999Z]`, and `2024-02` correctly ends on the 29th.

Grammar accepted: a 4-digit year, optionally narrowed to year-month, then full date, then a time. Following § search.html#date, **seconds are optional** (`2026-07-27T14:27Z` is valid — the search section departs from the XML Schema dateTime type here), while a timezone stays **required** once a time is present, as in the underlying `dateTime` datatype.

Normalizations and deviations:

- **A prefix-less value re-emits with its implied `eq`.** The spec assumes `eq` when no prefix is given, and the decoded shape always materializes one, so `2026-07` encodes back as `eq2026-07`. Same query, spelled explicitly.
- **Leap seconds collapse.** FHIR's grammar admits second `60`, which POSIX time cannot represent; such a value is accepted and both its bounds are pinned to the last representable instant of that minute (`…:59.999`).
- **Timezone-less times are rejected.** § search.html#date only _recommends_ a timezone when a time is present (and § 47 says a server should then assume its local zone), but the `dateTime` datatype grammar requires one, and bounds cannot be resolved to UTC without it. Spell the zone explicitly.
- **Dates are bounded in UTC.** Per § 46, dates carry no timezone and none should be considered, so a year/month/day value bounds in UTC rather than any local zone.

## DocumentReference choice / required modeling

`DocumentReference` has no `choice[x]` elements, so the XOR caveat above does not apply to it. Its modifier-required `status` (`current | superseded | entered-in-error`) is modeled as a plain required `Schema.Literal` (no `unknown`-default rescue like `Observation.status`, since HFS serves it reliably). `content` is `1..*` in the spec; the client models it as a plain (non-optional) array, so its presence is required on both the decoded and wire sides, but the array's non-emptiness (`min 1`) is **not** enforced — a payload with `content: []` validates. The `content.attachment` and `relatesTo.code`/`relatesTo.target` required sub-elements are likewise modeled as required (non-nullable) fields.

## MedicationRequest / MedicationDispense search parameters (only paging declared)

Per FHIR R4, `MedicationRequest.search` and `MedicationDispense.search` define parameters such as `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`/`context`, `status`, `intent` (request only), `authoredon` / `whenprepared` / `whenhandedover` (with date prefixes), `identifier`, `medication`, and `prescription` (dispense only). The `HttpApi` description declares `_count` and `_pageToken` only — same minimal paging surface as Observation. HFS indexes the full R4 parameter set server-side (e.g. `MedicationRequest.subject` feeds Patient `$everything`), but the typed client can't express those filters. Adding `subject`/`patient`/`code`/`status` would unlock the canonical medication workflows.

## `$everything` declared for Patient only (matches the server)

The `HttpApi` declares `GET /Patient/{id}/$everything` (with `_count`, returning a `Bundle`) on the Patient group only — added via `buildEverythingEndpoint` in `patient.ts`, not by `buildDomainResourceHttpApiGroup`. This matches the server, which implements the operation for Patient only. A resource that gains a server-side `$everything` later opts in with one `.add(buildEverythingEndpoint(...))` line.

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

The fhir-r4 datatype registry (`slices/emr/fhir-r4/src/data-types/base/datatype-registry.ts`) ships wire schemas for a subset of FHIR R4 `Datatype.Name` — primitives (`boolean`, `canonical`, `date`, `dateTime`, `decimal`, `id`, `instant`, `integer`, `positiveInt`, `string`, `time`, `uri`, `url`) plus complex (`Address`, `Annotation`, `Attachment`, `CodeableConcept`, `Coding`, `ContactPoint`, `Duration`, `HumanName`, `Identifier`, `Meta`, `Period`, `Quantity`, `Range`, `Ratio`, `Reference`, `SampledData`, `SimpleQuantity`, `Timing`). Any `value[x]` or `effective[x]` slot whose datatype is **not** registered (e.g. `valueMoney`, `valueAge`, `valueSignature`, `valueDistance`, `valueCount`, `valueBase64Binary`, `valueCode`, `valueMarkdown`, `valueOid`, `valueUuid`, `valueUnsignedInt`, …) behaves as follows on the wire:

- **Decode**: any wire content for an unregistered slot decodes to `null` (the slot exists at the type level so the in-memory shape still matches the decoded resource type).
- **Encode**: a non-null in-memory value at an unregistered slot **fails encoding** with a `ParseResult.Type` issue naming the unregistered datatype (`UnregisteredDatatype` tagged error in `datatype-registry.ts`). This is intentional — silent drops were the previous (pre-PR-#61) behavior and masked data loss.

`Duration` (`data-types/complex/duration.ts`) registers itself like every other complex datatype, so `Extension.valueDuration` round-trips. It was deliberately unregistered until web-trace's response-timing extension needed a `valueDuration`; the schema is also used directly by `MedicationRequest.dispenseRequest`'s duration fields.

`positiveInt` is seeded from `Datatype.baseSchemas` like every other primitive,
so `Extension.valuePositiveInt` round-trips. It was deliberately unregistered
until the Rexall/carebook dialect turned out to emit two of them — the
`sort-order` extension and the `number-of-repeats-available` modifierExtension —
which decoded to `null` and were silently lost. Note the dialect also dual-writes
that modifierExtension as a `v2` `valueDecimal`, which is why the loss went
unnoticed: the `v2` copy was the only readable one.

`Timing.repeat.boundsDuration` is still absent from `TimingRepeat` — the field was never modeled, only `boundsPeriod` and `boundsRange` are. Registering `Duration` removes the reason it could not be added, but adding the field is a separate change.

To register a new datatype: add an entry to `baseDatatypes` in `datatype-registry.ts` and a `registerDatatypeSchema('Name', NameSchema)` line at the bottom of its datatype module file.

Note: a single collation block (e.g. inside `choice-element-passthrough-fields.ts` or `datatype-registry.ts` importing every `complex/*.ts` and calling `registerDatatypeSchema` for each) would be tidier, but is not viable today — it re-enters a partially-loaded `base/element.ts` through the Element ⇄ Extension cycle, spreading `undefined` for `Element.fields` into every complex datatype's struct at construction time. The per-module registration pattern avoids that hazard.

## Post-merge audit (TODO)

A handful of finer-grained spec audits — the `topLevel: true` collision on domain-resource groups, choice element XOR enforcement, Reference target-type enforcement, etc. — are tracked under the **Post Merge Audit** epic on GitHub.
