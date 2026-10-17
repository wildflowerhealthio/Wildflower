# Source Identity Explanation

Why an imported resource is not stored under the id its source gave it, and what
replaces that id.

## Why a source's id is not the store's id

The on-device FHIR store is keyed by resource id: every write is a
`PUT /{Type}/{id}` (one per resource from `upsertResource`, or one per
entry of `persistBatchBundle`'s batch Bundle), so the id _is_ the upsert key.
Writing the id a source uses would make that key mean whatever each source means
by it:

- Two servers that both number their first patient `1` clobber each other.
- Rexall's carebook dialect gives a `MedicationRequest` and its
  `MedicationDispense` the **same** id, so anything keying on id alone collapses
  the pair.
- A source id is not required to be a legal FHIR id. `web-trace`'s session label
  is an arbitrary string, and one carrying a space yields an id no conformant
  server accepts.
- The source's own id has nowhere structured to live, so "what does the server
  call this?" is unanswerable.
- Cross-resource references resolve only where a source happens to agree with
  itself: an `Observation.subject` of `Patient/abc` lands because the Patient
  response kind also writes `abc`.

## The derivation

Every imported resource is keyed under a **derived local id**:

```text
localResourceId(sourceSystem, resourceType, originalId) → "wf-<32 lowercase hex>"
```

It lives in `fhir-r4/identity` and is two 64-bit FNV-1a lanes over the three
components, concatenated. The lane itself is `kitchen-sink`'s `fnv1a64` — the
standard algorithm, pinned in `fnv1a.test.ts` against the published FNV test
vectors, so "it is the standard implementation" is a checked fact rather than a
claim. What stays in `fhir-r4/identity` is what is _not_ standard FNV: the second
lane's displaced offset basis, the 128-bit concatenation, and the `wf-`
rendering.

Properties that matter:

- **Synchronous.** A response kind's `parse` stays runnable with
  `Effect.runSync`; Web Crypto's digest is async and would force every parse
  path to be async too.
- **Non-cryptographic is fine.** Nothing here defends against an adversary
  choosing colliding ids; the derivation only has to be stable and
  collision-resistant against ordinary source ids.
- **Always a legal FHIR id.** `wf-` plus 32 hex is 35 characters of
  `[A-Za-z0-9\-.]`, whatever went in.
- **The resource type is an input**, which is what separates Rexall's
  request/dispense pair.
- **The source system is an input**, which is what keeps two servers apart.

The `wf-` prefix is fixed rather than per-source. Source attribution lives in the
identifier, not in the id.

### The components are length-prefixed, not delimiter-joined

`joinIdComponents` renders the three components as `${length}:${value}`
concatenated — `1:a7:Patient3:abc` — rather than joining them on a separator.

A separator is only unambiguous if no component can contain it, which is a
precondition on every caller rather than a property of the function: with a
`\n` join, `('a', 'b\nc', 'x')` and `('a\nb', 'c', 'x')` would both spell
`a\nb\nc\nx` and collide outright. Nothing on a production path reaches such a
pair — `system` is a regex-validated root URL or a minted constant, and
`resourceType` is a union literal or the `[A-Za-z]+` capture from
`RELATIVE_REFERENCE` — but the function whose job is to make ids unambiguous
should not depend on its callers to be.

`joinIdComponents` is exported because a caller that has to fold more than one
value into a single `originalId` must fold it the same way rather than inventing
a separator. `web-trace`'s `(sessionId, requestId)` pair is one such caller;
nesting is safe, since a joined component is delimited by its own length prefix.

**The function is persisted wire format.** Its output is the primary key a
resource is stored under, so changing the prime, either offset basis, the
component encoding, the field order, or the prefix orphans everything already
stored. `local-resource-id.test.ts` pins exact outputs so that change fails
loudly.

## What adoption does to a resource

`adoptResource(source)` is the per-resource rewrite. Given a `SourceIdentity`
(`{ system, baseUrl? }`) it:

1. **Passes a null-id resource straight through.** There is no identity to adopt,
   and `upsertResource` cannot write one either.
2. **Derives the id** from `(system, resourceType, originalId)`.
3. **Prepends one `Identifier`** carrying the source's own id —
   `identifier[0] = { system: <source system>, value: <original id> }`. Every
   identifier the source already wrote is kept, behind it. There is deliberately
   no "already adopted?" guard: adoption runs exactly once per resource, at one
   choke point, so a source that publishes its own base URL as an identifier
   system yields a benign duplicate and nothing worse.
4. **Rewrites references** through the per-type field table below.

`Binary` is the exception to step 3: FHIR R4 gives it no `identifier` element, so
its original id survives only in the provenance trace. It is still adopted rather
than passed through, because a reference _to_ a Binary from a sibling resource
has to land on the same derived id. `originalIdOf` returns `null` for a Binary.

`originalIdOf(source, resource)` reads the source's id back off an adopted
resource — `identifier[0]` counts only if re-deriving from it reproduces the
resource's own id. Anything that needs the source's id after adoption (to build
a source-server URL, say) reads it there, never off `resource.id`.

### The reference rule

For one `Reference`:

```text
reference.reference is null                              → unchanged
strip a leading `${baseUrl}/` when the source declares one
the remainder does not match `^[A-Za-z]+/[A-Za-z0-9\-.]{1,64}$`  → unchanged
otherwise → reference := `${Type}/${localResourceId(system, Type, id)}`
            identifier := the existing one, or the source's id
```

The grammar check is what leaves alone: `#fragment` contained references,
`urn:uuid:`, foreign absolute URLs, version-specific `Type/id/_history/v`, ids
carrying a space, and hyphenated pseudo-types like carebook's
`rexall-pharmacy-location/pharmacy-4821`.

Rewrites apply to **any** resource-type token, not only the types the store
holds. The derivation is deterministic, so a `Location/x` link resolves
retroactively if that type is ever imported from the same source, and dangles
exactly as it would unrewritten if it never is.

A pre-existing `Reference.identifier` is **kept**. The slot is 0..1 and carebook
already fills it with its own pharmacy id; the original `Type/id` stays
recoverable by resolving the rewritten reference and reading the target's
`identifier[0]`.

`adoptedReferenceOf(source, Type, id)` applies this rule to a bare `Type/id`,
for a resource written outside that source that must point at what its import
stores (a synthetic lab result filed on the Patient a pharmacy import made);
`fhir-r4/resources`' `withSubject` files such a resource on it.

### Reference field table

| Resource             | Rewritten fields                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Binary`             | `securityContext`                                                                                                                                                                                                                                                                                                                                                         |
| `Patient`            | `generalPractitioner[]`, `managingOrganization`, `link[].other`, `contact[].organization`                                                                                                                                                                                                                                                                                 |
| `Observation`        | `subject`, `encounter`, `device`, `specimen`, `basedOn[]`, `derivedFrom[]`, `focus[]`, `hasMember[]`, `partOf[]`, `performer[]`, `note[].authorReference`                                                                                                                                                                                                                 |
| `MedicationRequest`  | `subject`, `encounter`, `requester`, `performer`, `recorder`, `priorPrescription`, `reportedReference`, `medicationReference`, `supportingInformation[]`, `reasonReference[]`, `basedOn[]`, `insurance[]`, `detectedIssue[]`, `eventHistory[]`, `dispenseRequest.performer`, `note[].authorReference`                                                                     |
| `MedicationDispense` | `subject`, `context`, `location`, `destination`, `statusReasonReference`, `medicationReference`, `partOf[]`, `supportingInformation[]`, `authorizingPrescription[]`, `receiver[]`, `detectedIssue[]`, `eventHistory[]`, `performer[].actor`, `substitution.responsibleParty[]`, `note[].authorReference`                                                                  |
| `DocumentReference`  | `subject`, `authenticator`, `custodian`, `author[]`, `relatesTo[].target`, `context.sourcePatientInfo`, `context.encounter[]`, `context.related[]`                                                                                                                                                                                                                        |
| `DiagnosticReport`   | `subject`, `encounter`, `basedOn[]`, `performer[]`, `resultsInterpreter[]`, `specimen[]`, `result[]`, `imagingStudy[]`, `media[].link`                                                                                                                                                                                                                                    |
| `Practitioner`       | `qualification[].issuer`                                                                                                                                                                                                                                                                                                                                                  |
| `ServiceRequest`     | `subject`, `encounter`, `requester`, `basedOn[]`, `replaces[]`, `performer[]`, `locationReference[]`, `reasonReference[]`, `insurance[]`, `supportingInfo[]`, `relevantHistory[]`                                                                                                                                                                                         |
| `ImagingStudy`       | `subject`, `encounter`, `referrer`, `procedureReference`, `location`, `basedOn[]`, `interpreter[]`, `endpoint[]`, `reasonReference[]`, `series[].endpoint[]`, `series[].specimen[]`, `series[].performer[].actor`                                                                                                                                                         |
| `CarePlan`           | `subject`, `encounter`, `author`, `basedOn[]`, `replaces[]`, `partOf[]`, `contributor[]`, `careTeam[]`, `addresses[]`, `supportingInfo[]`, `goal[]`, `note[].authorReference`, `activity[].outcomeReference[]`, `activity[].progress[].authorReference`, `activity[].reference`, `activity[].detail.{reasonReference[], goal[], location, performer[], productReference}` |
| `Goal`               | `subject`, `expressedBy`, `addresses[]`, `outcomeReference[]`, `note[].authorReference`                                                                                                                                                                                                                                                                                   |
| `PlanDefinition`     | `subjectReference`, `action[].subjectReference` (recursively through nested `action[]`)                                                                                                                                                                                                                                                                                   |
| `Procedure`          | `subject`, `encounter`, `recorder`, `asserter`, `location`, `basedOn[]`, `partOf[]`, `performer[].actor`, `performer[].onBehalfOf`, `reasonReference[]`, `report[]`, `complicationDetail[]`, `focalDevice[].manipulated`, `usedReference[]`, `note[].authorReference`                                                                                                     |

`adoptResource` dispatches with `Match.exhaustive` over the closed `FhirResource`
union, so a resource type added to the union without an adopt function is a
compile error rather than a resource that silently keeps its source's id.

The list is explicit rather than a structural walk, so what gets rewritten is
readable and reviewable. `adopt-resource.test.ts` guards it from both sides:

- It diffs the _complement_ of this table on generated resources, so a field
  touched **outside** it fails.
- It walks each resource schema's own AST for every path that declares a
  `Reference`, and asserts that set is exactly the rewritten paths. So a
  `Reference` field missing from **both** the implementation and the table fails
  too — the case the complement diff structurally cannot see, because a field
  nobody rewrites is a field the complement asserts was left alone.

The second guard is what catches a `Reference` that is easy to miss by eye, such
as `note[].authorReference`: `Annotation.author[x]` is a `Reference` when it is
not the `authorString` variant, and it sits one level down inside an array.

The walk stops at every `Reference` (that is the find) and at every `Identifier`
(whose `assigner` is exempt wherever it is reached from), which is also what
breaks the `Reference` ⇄ `Identifier` cycle. `extension`, `modifierExtension` and
`contained` are pruned as exempt subtrees; `Extension` is recursive, so
descending would not terminate anyway.

### Never touched

`contained` (raw passthrough JSON — a decoded `Identifier` injected there writes
`null`s onto the wire), `extension` / `modifierExtension` including any
`valueReference` inside them, `meta.source`, `Identifier.assigner`,
`groupIdentifier`, and `Attachment.url`.

`meta.source` is not a rewrite site because at adoption time it holds a
source-system URI, and the importer's decode stamps it with a reference to the
source-file `DocumentReference` afterwards — rewriting it earlier is dead work.

## Where a source package states its identity

Adoption is **one option-less per-kind combinator**, `adoptUnderRecognizedRoot`
(in `fhir-r4/identity`). It wraps a single response kind, replacing its `parse`
with one that adopts the parse output under the identity **the kind's own
`tryRecognize` mints for the response's URL** — read verbatim from
`entity.tryRecognize(response.url, response.method).source`, with no source
passed in. Each kind constructs its own identity, so recognition and the
namespace a resource keys under are the one decision:

- **FHIR** (`fhir-r4-source`) — `tryRecognize` returns `source: { system: root,
  baseUrl: root }`, the root captured by the kind's own `UrlMatch`. So a resource
  keys under the root of the URL it arrived on, and `baseUrl` makes a server that
  spells its own references absolutely rewrite them the same as relative ones.
- **Rexall / Shoppers** (`rexall-be-well-source`, `shoppers-drugmart-source`) —
  `tryRecognize` (via `http-extraction-fundamentals`' `recognizePortal`) stays
  URL-gated but mints a constant `source: { system: SID }`
  (`REXALL_CAREBOOK_SYSTEM` / `SHOPPERS_DRUGMART_SYSTEM`, Wildflower-minted `sid`
  URIs in each package's `source-system.ts`), no `baseUrl` because references
  are relative.

The seam is applied per kind at **module load**: each per-source package in
`slices/http-extraction` `.map`s its kind list through the combinator once in its
`response-kinds.ts` and exports the result as its `SourceDescriptor`'s
`responseKinds`. The HAR importer (`har-importer-core`'s pool) runs those kinds
as they are, already adopted, and never adopts again.

Consequences worth knowing:

- **No source parameter means no memo.** The identity lives inside
  `tryRecognize`, so the combinator takes nothing to parameterize: a package
  applies it once and every consumer shares the same frozen kind **by
  reference**.
- **An unrecognized URL fails as a `ParseError`.** A `parse` on a response whose
  `tryRecognize` returns `None` — or `Some` with no `source` — **fails** with a
  `ParseError` naming the real reason ("URL not recognized by this kind — cannot
  adopt an identity"), on the same channel a decode failure uses. No channel
  widening, no defect, and `Extraction.parseWith` folds it to an ordinary
  per-response `parseError` outcome. In practice routing only ever hands a kind a
  URL it recognized, so this arm guards a misconfiguration, not a normal
  response.
- **The guard is per kind, and reads the whole `FhirResource` union.** Adoption
  widens: `adoptResource` is declared `FhirResource → FhirResource`, because
  TypeScript cannot correlate the variant matched with the branch taken. A
  combinator returning the kind's type unchanged would therefore be asserting
  something it does not deliver for a kind that declares a narrower element type.
  `adoptUnderRecognizedRoot` refuses such a kind, via a conditional on the
  parameter (`TEntity & EntityParsesEveryResource<TEntity>`) — the constraint
  alone cannot do it, since a narrower kind is a legitimate subtype by
  covariance. The fix is to widen the kind list to
  `HttpResponseKind<FhirResource>[]` **before** the `.map`, as each source
  package's `response-kinds.ts` does.

Note the variant preservation inside `adoptResource` is real but unchecked: each
`adoptX` maps a variant to itself **by construction**, and an `adoptX` that
returned a different variant would compile. That is stated on the function.

## web-trace mints its own ids, at its codec

A trace's id is minted by `web-trace-core`'s `traceResourceId`, the single
definition of that encoding, rather than by adoption:

```ts
traceResourceId({ sessionId, requestId }) = localResourceId(
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
  'DocumentReference',
  joinIdComponents([sessionId, requestId])
)
```

`(sessionId, requestId)` is the identity of an exchange, and both halves stay
readable as `Identifier` entries the decode side reads. Going through the
derivation also makes an illegal id unrepresentable.

The pair goes through `joinIdComponents` rather than a `-` join for the reason
given above: both halves are arbitrary non-empty strings, so `('s-req', '77')`
and `('s', 'req-77')` would be the same exchange, one silently upserting over the
other.

**The derivation is not free, and a render must not pay it per row.** It is two
hash lanes over the encoded pair. A list keys its rows and its selection with
the same encoded pair, unhashed, because a React `key` and a selection key need
identity within one list, not the resource id. Calling `traceResourceId` in a
render body costs ~24 ms per keystroke over a thousand-exchange session.

**One id-minting site per resource kind.** Running a trace through
`adoptUnderRecognizedRoot` as well would hash a hash, so a trace is never
adopted.

## One format, no guards

Every resource in the store is keyed by this derivation — there is no second id
format to recognize, so nothing reads or writes one. Adoption likewise runs
exactly once per resource, at the response-kind seam, so there is deliberately
no "already adopted?" guard: such a guard has to guess, and a source that
publishes its own base URL as an identifier system makes it guess wrong.

## Person vs source Patient

Adoption keys every resource under its source, so a Patient is keyed too: one
human with a Rexall account, a Shoppers account and a hospital record arrives
as three Patients, and each `MedicationRequest.subject` or
`Observation.subject` names its own one. The store keeps **one Patient per
human**, not one per provider–human relationship.

A **source Patient is never a person.** A person is a Patient the user owns,
and it accumulates the identifiers of every source Patient merged into it. At
an import's confirm (`importer-fundamentals`' `StagedImport.chosenResources`,
through `PatientIdentity`), each source Patient goes one of two ways:

- **`'new'`** — it is written as it is, and becomes the person.
- **`{ person }`** — it is merged into an existing person. The person gains
  every identifier of the source Patient it does not already carry (matched on
  `system` + `value`) and nothing else: the person's demographics are the
  truth, and a source's spelling of them is not. Every `Reference` whose
  `reference` is exactly the source Patient's `Patient/<id>` is re-pointed at
  the person; its `identifier` and `display` stay. The source Patient itself
  is not written.

References are found by walking each resource against `fhir-r4`'s own
`Reference` schema, not through a field table like adoption's, so a reference
anywhere in a resource moves with the person. An absolute or identifier-only
reference to the source Patient is left alone and counted, so the review can
say how many references were not rewritten.

Merging keeps one row per human, so it writes no `Patient.link`. A later import
finds its person by searching each of the source Patient's identifiers in
order (`GET Patient?identifier=system|value`, `PatientSearch`): the adopted
source id comes first, and the first hit wins. That works because the person
carries the merged source's adopted identifier. Resources already stored from
imports made before a merge are not re-linked.

### Household accounts

A **household account** is a source Patient that `link.seealso`s the Patients
of the people it manages. Shoppers makes one: its account `Patient`, keyed by
the account's `pcid` (`ShoppersIdentifierSystem.PcId`), links each managed
person's demographic `Patient`. The history feed does not say which person a
fill was for, so a history `MedicationDispense.subject` names the account.

- **A fill goes to the clinical Patient when the import says who that is.** A
  dispense filed on a household account is re-filed on the `subject` of its
  `authorizingPrescription` `MedicationRequest`, when the import decoded that
  request (written or not) and the request names a subject. This runs before
  the merge rewrite, so a fill lands on the family member and then, through
  the merge, on the person, in one pass.
- **Otherwise the fill stays on the account,** and is counted with the
  references not rewritten.
- **A household account is a Patient and is written,** but no search matches
  it into a person: none of its identifiers is searched, so it defaults to
  `'new'`, and only the reviewer assigns it elsewhere. Matching it by `pcid`
  would attribute every earlier fill of the whole family to one person.
- **An account that links nobody is the person it names,** and is matched,
  merged and assigned like any other source Patient.

Nobody on the team has a multi-person Shoppers account. These rules were built
from fixtures modelled on a two-person account (`customer-response-kind.test.ts`)
and have not been checked against a real one.

## References

- [http-extraction AGENTS.md](../../../http-extraction/AGENTS.md) — the
  response-kind / source-descriptor vocabulary the per-source packages build on.
- [har-importer-core AGENTS.md](../../../importer/har-importer-core/AGENTS.md) —
  the importer that runs the pre-adopted kinds over a HAR.
- [web-trace-core AGENTS.md](../../../web-trace-core/AGENTS.md) — the codec that
  mints trace ids.
- [importer-fundamentals AGENTS.md](../../../importer/importer-fundamentals/AGENTS.md)
  — `PatientIdentity` and `PatientSearch`, which merge a source Patient into
  its person.
