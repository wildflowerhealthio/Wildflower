# FHIR R4 Client Capabilities (gaps and gotchas)

This is an **internal scratch doc** — not a published FHIR `CapabilityStatement` resource, and **not a description of the server**. It catalogues the capabilities and gaps of the **`fhir-r4` TypeScript client** in `slices/emr/`: what its wire schemas validate and what its `HttpApi` description (and therefore the typed client) declares. Every entry is scoped to that client layer.

Server behaviour — validation, search, pagination, conformance — is **out of scope here**. The server is the off-the-shelf HFS Rust server embedded by `emr-rust` and mounted at `/fhir-r4`; it lives outside this slice's TypeScript surface and keeps no capability catalogue of its own (HFS implements standard FHIR R4). The client is hand-synchronized to what HFS serves — see "No drift guard against the HFS server" below.

Each entry is a place where the client deviates from, narrows, or postpones the FHIR R4 spec. None are blockers; they are simply not implemented in the client yet. When a deviation is fixed, delete or amend the entry. When a new gap is introduced (or noticed), add one.

## No drift guard against the HFS server

The `HttpApi` definition and the schemas here are hand-synchronized with what HFS actually serves at `/fhir-r4/*`. There is no OpenAPI-snapshot or CapabilityStatement-based drift test (deliberate, for now): `emr-rust` mounts HFS's router wholesale, so there is nothing to annotate with `utoipa` on the Rust side. If the two sides diverge, nothing fails automatically — changes to either side need a manual cross-check.

## The `HttpApi` is base-relative; the mount prefix is re-applied by consumers

`FhirResourcesApi` no longer carries `.prefix('/fhir-r4')`. The typed client emits **base-relative** paths (`/Patient`, `/DocumentReference/{id}`), so it can be pointed at any FHIR server — Wildflower's host, a SMART sandbox, an arbitrary open R4 base. Naming the base is the **consumer's** job:

- **Host app wiring** (`apps/wildflower-react`'s `router-context.ts`) re-applies `FhirResourcesApiPrefix` (`/fhir-r4`, still exported here) by wrapping the FHIR slice's `HttpClient` with `prependApiBaseUrl(httpClientLayer, FhirResourcesApiPrefix)`, so the host webview's reads still resolve to `{origin}/fhir-r4/…`.
- **OpenAPI generation** (`http-api-definition/openapi-drift.test.ts`) re-applies the same prefix to every `spec.paths` key after `OpenApi.fromApi`, so the committed `emr-rust/openapi/fhir-r4.openapi.json` — embedded by `emr_rust::openapi_spec` for the host's `/docs` page — keeps showing the mounted `/fhir-r4/…` paths, byte-identical to before the de-prefix.
- **Self-hosted SMART apps** (`fhir-r4-react/smart`'s `smartHttpClientLayer`) prepend the `iss`/picked server URL verbatim.

The `/fhir-r4` mount path itself is unchanged on the server side — only where it is applied on the client side moved.

## Choice element at-most-one rule

FHIR R4 choice elements (`Patient.deceased[x]`, `Patient.multipleBirth[x]`, `Observation.value[x]`, `Observation.effective[x]`, `Observation.component.value[x]`, `Extension.value[x]`, `MedicationRequest.medication[x]`, `MedicationRequest.reported[x]`, `MedicationRequest.substitution.allowed[x]`, `MedicationDispense.medication[x]`, `MedicationDispense.statusReason[x]`, `DiagnosticReport.effective[x]`, `Dosage.asNeeded[x]`, `ServiceRequest.quantity[x]`, `ServiceRequest.occurrence[x]`, `ServiceRequest.asNeeded[x]`) allow at most one populated slot. Each is modeled as one independent optional field per variant (`choiceElementSetPassthroughFields(prefix, variants)`), and the containing struct is piped through `filterForExclusiveChoiceElementSet(prefix, variants)` — a `Schema.filter` that counts the non-null `${prefix}*` slots and fails when there are two or more. The STU3-as-R4 `MedicationRequest.medication[x]` and `MedicationDispense.medication[x]` schemas in `fhir-stu3-as-r4` carry the same guard.

The rule is enforced on both sides of the wire:

- **Decode**: a payload setting both `valueString` and `valueInteger` (or `deceasedBoolean` and `deceasedDateTime`, …) fails with a `ParseResult.Type` issue naming every populated slot: `choice element value[x] allows at most one populated slot, but found 2: valueString, valueInteger`. The slots are listed in the choice element's variant order.
- **Encode**: a decoded value with two slots set fails with the same issue, so the client never emits the invalid wire JSON.

The per-slot field types are unchanged: the decoded resource still carries every `${prefix}*` key, with `null` for the unpopulated ones.

Remaining gaps:

- **Unregistered slots are invisible to the check.** A slot whose datatype has no fhir-r4 wire schema decodes to `null` (see [Unregistered choice-element datatypes](#unregistered-choice-element-datatypes-valuex--effectivex)), so a wire payload pairing, say, `valueMoney` with `valueString` decodes with only `valueString` set. Encoding a non-null unregistered slot still fails.
- **`Dosage.doseAndRate` `dose[x]` / `rate[x]` are not guarded.** Their `SimpleQuantity` variant is named `…Quantity` on the wire, so they are modeled as explicit `doseRange`/`doseQuantity`/`rateRatio`/`rateRange`/`rateQuantity` fields rather than through the choice-element helpers, and a payload setting two of them validates.
- **Required choice elements are not required.** FHIR marks `MedicationRequest.medication[x]` and `MedicationDispense.medication[x]` as 1..1; with every variant optional, a payload with no medication slot set also validates.
- **`Schema.omit` / `Schema.pick` drop the guard.** Effect rebuilds the struct without its refinements. `withMandatoryId` — the `id`-narrowing wrapper the HTTP API definition applies to every resource — re-applies them; any other schema derived that way from a guarded resource has no guard.

## `Observation.status` defaulted to `unknown` when absent

FHIR R4 marks `Observation.status` as required (1..1). Real servers — notably HAPI's public sandbox — nonetheless return hand-entered Observations that omit it, and in a search `Bundle` a single such entry would otherwise fail the decode of the **entire page** (`Bundle.Schema(Observation.Schema)` types `entry.resource` as `Observation | undefined`, so a status-less resource matches neither arm). The client therefore models `status` as `Schema.optionalWith(StatusSchema, { default: () => 'unknown' })`: a **missing/undefined** status decodes to FHIR's own `unknown` sentinel, so the resource (and its Bundle page) survives.

This rescues **absence only**. A status that is present but not a valid code — an unrecognized string, or `null` — still fails decode with a `ParseError`; a bad value is never coerced.

Consequence on the types: because accepting a missing status on decode and the declared Encoded (wire) type are the same side, the schema's Encoded type now marks `status` **optional** (reflected in the `ObservationSchema` annotation, which `Omit`s `status` from `FhirR4.Observation` and re-adds it optional). The **published** contract is unchanged, though: the hand-written `observationJsonSchema` annotation still lists `status` in `required`, and it — not the derived struct — drives the OpenAPI snapshot, so the OpenAPI/drift guard sees no change.

## Medication resource (just-enough, added for the STU3 → R4 bridge)

`Medication` is modeled with its standard R4 fields (`code`, `status`,
`manufacturer`, `form`, `amount`, `ingredient[]`, `batch`) plus the
`DomainResource` extension array, primarily to give `fhir-stu3-as-r4`'s
STU3→R4 transforms a real R4 target.
`Medication.ingredient.item[x]` (CodeableConcept | Reference) is two explicit
optional fields without the at-most-one guard (see
[Choice element at-most-one rule](#choice-element-at-most-one-rule)), so setting
both validates. A `Medication.empty` all-absent default is
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

The SMART apps do not hit this gap, because they do not use the typed client: `fhir-r4-react/smart`'s `fetchPatientPage` / `fetchPatient` issue raw fhirclient requests (`Patient?_sort=family&_count=200`, `Patient/{id}`) and decode the answer with `Patient.Schema`. Anything they need beyond what the `HttpApi` declares — here `_sort` — is expressible there without touching this description. The gap above is still real for every consumer that does go through the typed client.

## Observation search parameters (only paging declared)

Per FHIR R4 § Observation.search, the standard parameters include `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`, `date` (with prefixes), `status`, `category`, `identifier`, `performer`, `value-quantity`, `value-string`, `value-concept`, `code-value-quantity`, `component-code`, `component-value-quantity`, etc. The `HttpApi` description declares `_count` and `_pageToken` only.

Implication: the typed client cannot ask "latest blood pressure for this patient" — the primary reason to query Observation. Adding `subject`/`patient`/`code`/`category`/`date` would unlock the canonical workflows.

The SMART viewer reads Observations around this, not through it: `fhir-r4-react/smart`'s `fetchObservationPage` issues a raw fhirclient `Observation?patient=<id>&_sort=date&_count=200` and decodes each entry with `Observation.Schema`. That is why `patient`/`date` being undeclared here has not blocked the viewer — and why closing this gap is still worth doing for the typed client's own consumers.

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

`DocumentReference` has no `choice[x]` elements, so the choice-element rule above does not apply to it. Its modifier-required `status` (`current | superseded | entered-in-error`) is modeled as a plain required `Schema.Literal` (no `unknown`-default rescue like `Observation.status`, since HFS serves it reliably). `content` is `1..*` in the spec; the client models it as a plain (non-optional) array, so its presence is required on both the decoded and wire sides, but the array's non-emptiness (`min 1`) is **not** enforced — a payload with `content: []` validates. The `content.attachment` and `relatesTo.code`/`relatesTo.target` required sub-elements are likewise modeled as required (non-nullable) fields.

## DiagnosticReport search parameters (subset declared)

Per FHIR R4 § DiagnosticReport.search, the standard parameters include `_id`, `_lastUpdated`, `patient`, `subject`, `encounter`, `code`, `category`, `status`, `date` (with prefixes), `issued`, `identifier`, `performer`, `result`, `results-interpreter`, `specimen`, `conclusion`, `media`, `based-on`. The `HttpApi` description (and therefore the typed client) declares: `_count`, `_pageToken`, `_id`, `identifier`, `category`, `code`, `status`, `subject`, `date`.

`status` is narrowed to the `DiagnosticReport.status` value set, so an out-of-set code fails to typecheck. `date` is the shared **`DateSearchParam`** value (see "Date search parameter modelling" below) and maps to `effective[x]`, as the spec defines it. `subject` is the one reference-typed parameter declared on any resource here — the literal `Patient/<id>` string a patient's lab reports are gathered by (the same `subject=` search the server's `$everything` runs). `patient`, `performer`, `result` and the rest of the reference parameters are not declared, and every parameter is single-valued (see the DocumentReference narrowings above).

## Practitioner search parameters (subset declared)

Per FHIR R4 § Practitioner.search, the standard parameters include `_id`, `_lastUpdated`, `identifier`, `name`, `family`, `given`, `phonetic`, `telecom`, `email`, `phone`, `address` and its parts, `gender`, `active`, `communication`. The `HttpApi` description declares: `_count`, `_pageToken`, `_id`, `identifier`, `name`. `name` is a FHIR `string` parameter matched against any part of the practitioner's names; the rest are not declared, so a client looking a practitioner up by licence number goes through `identifier` (the `system|value` form) rather than a dedicated parameter.

## DiagnosticReport / Practitioner choice / required modeling

`DiagnosticReport.effective[x]` is `dateTime | Period`, modeled the same way as `Observation.effective[x]` (both slots optional, at most one populated — see above). Its required `status` (the ten-code `DiagnosticReport.status` value set) and `code` are modeled as plain required fields, with no `unknown`-default rescue for `status`: an absent status fails the decode. `media.link` is likewise required. `Practitioner` has no choice elements and no required fields beyond `resourceType`; its `qualification.code` is modeled as required, per the spec's 1..1.

## MedicationRequest / MedicationDispense search parameters (only paging declared)

Per FHIR R4, `MedicationRequest.search` and `MedicationDispense.search` define parameters such as `_id`, `_lastUpdated`, `code`, `subject`, `patient`, `encounter`/`context`, `status`, `intent` (request only), `authoredon` / `whenprepared` / `whenhandedover` (with date prefixes), `identifier`, `medication`, and `prescription` (dispense only). The `HttpApi` description declares `_count` and `_pageToken` only — same minimal paging surface as Observation. HFS indexes the full R4 parameter set server-side (e.g. `MedicationRequest.subject` feeds Patient `$everything`), but the typed client can't express those filters. Adding `subject`/`patient`/`code`/`status` would unlock the canonical medication workflows.

## `POST /` batch bundle (endpoint + persist client)

The `HttpApi` declares the FHIR `POST /` bundle-submit endpoint (`Bundle.Submit` in the typed client). The endpoint accepts a `Bundle{ type: 'batch' | 'transaction' }` and returns a `Bundle{ type: 'batch-response' | 'transaction-response' }` with a per-entry `response.status` (and, for reads, a `resource`). The mount prefix `/fhir-r4` is applied by consumers (see "The `HttpApi` is base-relative" above), so the endpoint lives at bare `/`.

Only **batch** semantics are exercised by this client's helpers today:

- **`persistBatchBundle(resources)`** (in `fhir-r4/clients`) is the batch counterpart of `persistResources`: one `POST /` submission carrying N PUT entries, one round trip per batch. It reports the **whole** per-entry result as `BatchEntryOutcome[]` — one per submitted resource, in submit order, carrying the echoed status, whether it succeeded (`ok`), and any diagnostics parsed from the entry's `response.outcome` OperationOutcome (`WriteIssue[]`: `severity`/`code`/`text`). A whole-bundle failure attributes every resource to that one cause under the `NO_RESPONSE_STATUS` sentinel; a truncated response yields the same sentinel with no issues. Null-id resources are skipped defensively (a PUT needs an id). It is the importer's write sink — the results view groups the outcomes by status code — while the collector slice still uses `persistResources` (real-time sync with per-resource retries), which reports only failures as `ResourceWriteFailure[]`.
- **`classifyAgainstServer(resources)`** (same package) pre-fetches the FHIR store's current copy of each id in one `POST /` batch of GET entries and classifies each as `new` (absent), `unchanged` (server holds a wire-equal copy after dropping the server-managed `meta.versionId` / `meta.lastUpdated` / `meta.source`), or `changed` (present + differs). Never fails — a whole-bundle failure attributes every id to `new` so the caller's writes still attempt. The importer's shell runs it at preview mount and pre-excludes `unchanged` rows so a re-import writes nothing by default.

Two shape narrowings on this client:

- **The endpoint's entry `resource` type is `Schema.Any`, not the FHIR union.** Modeling `Bundle{entry.resource}` as `FhirResourceSchema` (the discriminated union of the eight domain resources) exploded the inferred client type past TS's serialize limit ("inferred type … exceeds the maximum length" on `FhirR4ResourcesHttpApiClient`). Every in-slice caller inspects a response by `entry.response.status` and decodes any returned `entry.resource` through `FhirResourceSchema` separately when it needs the typed shape, so the loose entry-body type never reaches a caller as truth.
- **Transaction semantics (atomic all-or-nothing) is not implemented.** The `Bundle.Submit` endpoint accepts a `transaction`-typed bundle at the type level, but no client helper builds one; a caller that wanted transaction semantics would raise both `entry.request` and the response-parsing side (a `500` on the whole bundle fails the transaction as a unit). Batch is enough for the importer's needs today (the reviewed set is preview-confirmed, so per-entry failure is the observability the user wants).

The server (HFS) supports both batch and transaction bundles at `POST /fhir-r4` per its capability statement — the client-side narrowing is the only asymmetry.

## `$everything` declared for Patient only (matches the server)

The `HttpApi` declares `GET /Patient/{id}/$everything` (with `_count`, returning a `Bundle`) on the Patient group only — added via `buildEverythingEndpoint` in `patient.ts`, not by `buildDomainResourceHttpApiGroup`. This matches the server, which implements the operation for Patient only. A resource that gains a server-side `$everything` later opts in with one `.add(buildEverythingEndpoint(...))` line.

What the server actually returns for `Patient/{id}/$everything` — which related types it gathers, and how (an indexed, server-side, fully-paged `subject=` search per type) — is server behaviour and lives in the emr-rust [Capability Statement](../../emr-rust/docs/Capability%20Statement.md), not here.

## Patient invariant `pat-1` not enforced

FHIR R4 invariant `pat-1` on `Patient.contact` requires at least one of `name`, `telecom`, `address`, `organization` to be present. We do not enforce this; an empty contact backbone validates.

## Patient.communication / Patient.contact wire shape (fixed)

These are now serialized as "absent or non-empty array" matching every other `0..*` field on Patient (was previously `null` or array).

## Bundle entry sub-elements (typed)

`Bundle.entry.request`, `Bundle.entry.response`, `Bundle.entry.search`, `Bundle.entry.link`, and top-level `Bundle.link` are now typed as proper BackboneElement structs (`request.method` is the HTTP-verb enum, `search.mode` is `match|include|outcome`, etc.). `Bundle.signature` remains `Schema.Any`.

`Bundle.entry.response.outcome` is typed as a **minimal `OperationOutcome`** — `resourceType` plus `issue[]` (`severity`/`code`/`diagnostics`/`details.text`), the fields a batch-response's per-entry diagnostics carry. It is modeled only as far as `persistBatchBundle` needs to render those messages; the spec's coded value sets for `severity`/`code` stay `Schema.String` (the server's exact token), and `OperationOutcome` is **not** a member of `FhirResourceSchema` — it exists only inside an entry response, never as a standalone resource. This matches FHIR R4, which types `Bundle.entry.response.outcome` as any `Resource`.

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

**Deviation — `positiveInt` accepts any integer, including `0` and negatives.**
FHIR R4 defines `positiveInt` as an integer strictly greater than zero, and the
registered schema is `Schema.Int` with no positivity refinement. This is
deliberate. A `value[x]` slot sits inside an `Extension` inside a resource, and
Effect decode is all-or-nothing, so a refinement failure on one extension value
fails the **whole enclosing resource** — and a caller that decodes a
heterogeneous bundle through a union with a catch-all (the
`rexall-be-well-collector` medication list is one) can only observe that as the
resource silently disappearing. Vendors really do send `valuePositiveInt: 0`:
carebook writes the remaining-repeats count that way, so a prescription with no
repeats left would have deleted itself from the medication list. Reject
out-of-range values where they are read and it matters, not in the wire decode.
`slices/emr/fhir-r4/src/data-types/base/datatype-registry.test.ts` pins all
three cases (positive round-trip, `0` decodes, non-integer still rejected).

`Timing.repeat.boundsDuration` is still absent from `TimingRepeat` — the field was never modeled, only `boundsPeriod` and `boundsRange` are. Registering `Duration` removes the reason it could not be added, but adding the field is a separate change.

To register a new datatype: add an entry to `baseDatatypes` in `datatype-registry.ts` and a `registerDatatypeSchema('Name', NameSchema)` line at the bottom of its datatype module file.

Note: a single collation block (e.g. inside `choice-element-passthrough-fields.ts` or `datatype-registry.ts` importing every `complex/*.ts` and calling `registerDatatypeSchema` for each) would be tidier, but is not viable today — it re-enters a partially-loaded `base/element.ts` through the Element ⇄ Extension cycle, spreading `undefined` for `Element.fields` into every complex datatype's struct at construction time. The per-module registration pattern avoids that hazard.

## ServiceRequest search parameters (subset declared)

Per FHIR R4 § ServiceRequest.search, the standard parameters include `_id`, `_lastUpdated`, `identifier`, `status`, `intent`, `code`, `subject`, `patient`, `encounter`, `authored`, `requester`, `performer`, `category`, `priority`, `body-site`, `occurrence`, `based-on`, `replaces`, `instantiates-canonical`, `instantiates-uri`, `requisition`, `specimen`. The `HttpApi` description (and therefore the typed client) declares: `_count`, `_pageToken`, `_id`, `identifier`, `status`, `intent`, `code`, `subject`, `authored`.

`status` is narrowed to the `ServiceRequest.status` value set (`draft | active | on-hold | revoked | completed | entered-in-error | unknown`). `intent` is narrowed to the `ServiceRequest.intent` value set (`proposal | plan | directive | order | original-order | reflex-order | filler-order | instance-order | option`). `authored` is the shared **`DateSearchParam`** value (see "Date search parameter modelling" above).

Notably absent: `patient` (same as `subject` but typed to Patient only), `encounter`, `requester`, `performer`, `category`, `priority`. Every parameter is single-valued (see the DocumentReference narrowings above).

## ServiceRequest choice / required modeling

`ServiceRequest.quantity[x]` (Quantity | Ratio | Range), `ServiceRequest.occurrence[x]` (dateTime | Period | Timing), and `ServiceRequest.asNeeded[x]` (boolean | CodeableConcept) are each modeled as independent optional fields via `choiceElementSetPassthroughFields`, with at most one populated slot per element (see "Choice element at-most-one rule" above). Required `status`, `intent`, and `subject` are modeled as plain required fields; `authoredOn` is nullable-optional (FHIR R4 marks it 0..1). `note` is typed as `Schema.Array(Schema.Any)` — Annotation backbone elements are not individually typed. `specimen` is omitted from the schema entirely (ServiceRequest is modeled for radiology/DICOM order tracking, not lab orders). `ServiceRequest.medication[x]` does not exist on this resource (it is not MedicationRequest).

## ImagingStudy search parameters (subset declared)

Per FHIR R4 § ImagingStudy.search, the standard parameters include `_id`, `_lastUpdated`, `identifier`, `status`, `subject`, `patient`, `encounter`, `started`, `modality`, `bodysite`, `dicom-class`, `instance`, `performer`, `reason`, `series`, `endpoint`, `basedon`. The `HttpApi` description declares: `_count`, `_pageToken`, `_id`, `identifier`, `status`, `subject`, `started`, `modality`, `basedOn`.

`status` is narrowed to the `ImagingStudy.status` value set (`registered | available | cancelled | entered-in-error | unknown`). `started` is the shared **`DateSearchParam`** value (see "Date search parameter modelling" above). `modality` and `basedOn` are plain strings — `modality` carries the DICOM modality code (e.g. `CT`, `MR`), and `basedOn` a literal reference string.

Notably absent: `patient`, `encounter`, `bodysite`, `dicom-class`, `instance`, `performer`, `reason`, `series`, `endpoint`. Every parameter is single-valued.

## ImagingStudy choice / required / backbone modeling

`ImagingStudy` has no choice elements. Required `status` and `subject` are modeled as plain required fields. `modality` is typed as `Coding[]` (per R4: a summary of each series' modality, **not** CodeableConcept — the study-level `modality` is a Coding in R4, changed to CodeableConcept in R5). `numberOfSeries` and `numberOfInstances` are non-negative integers (nullable-optional).

`ImagingStudy.series` is modeled as a full backbone element (`imaging-study-series.ts`) carrying:

- Required: `uid` (String, the DICOM UID), `modality` (Coding, the series-level acquisition modality)
- Optional: `number` (non-negative int), `description`, `numberOfInstances` (non-negative int), `endpoint` (Reference[]), `bodySite` (Coding), `laterality` (Coding), `specimen` (Reference[]), `started` (String), `performer` (array of `{ function?: CodeableConcept, actor: Reference }`), `instance` (array of series-instance backbone)

`ImagingStudy.series.instance` is a nested backbone element (`imaging-study-series-instance.ts`) with required `uid` and `sopClass` (Coding) plus optional `number` and `title`.

`note` is typed as `Schema.Array(Schema.Any)` — Annotation not individually typed. `procedureReference` is typed as a nullable Reference (no target-type enforcement — same gap as all References here). `ImagingStudy.procedureCode` is typed as CodeableConcept[]; the spec marks it 0..*.

## Post-merge audit (TODO)

A handful of finer-grained spec audits — the `topLevel: true` collision on domain-resource groups, Reference target-type enforcement, etc. — are tracked under the **Post Merge Audit** epic on GitHub.
