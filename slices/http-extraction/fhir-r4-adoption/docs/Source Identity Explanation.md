# Source Identity Explanation

Why an imported resource is not stored under the id its source gave it, what
replaces that id, and how an import links the patients and providers its
sources name to the ones already on the device. The derivation is `fhir-r4`'s
(`fhir-r4/identity`); adoption, which applies it to what a source decodes, is
this package's; the identity map is `importer-fundamentals`', stated here as a
model.

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

`adoptInIdSpace(idSpace)` is the per-resource rewrite of a record and the id
it is adopted under. The `IdSpace` says who assigned that id: a `FhirServer`
(its root is the hash domain and identifier system, and a reference under
`${base}/` reads as relative), a `SourceSystem` (a Wildflower-minted coding
system), a `ContentDigest` `within` one of those, or a `SourceFile`.
`adoptResource(source)` is the decode-time entry point over it: given a
`SourceIdentity` (`{ system, baseUrl? }`) it adopts in the source's
`FhirServer` space when it has a `baseUrl` and its `SourceSystem` space when
not, and it:

1. **Takes its `DecodedId`.** `FoundInSource` is the id the source gave it.
   A resource whose `id` is `null` (third-party FHIR JSON, where `id` is
   optional) is `GeneratedFromContent` instead, adopted as a `ContentDigest`
   within the source's space: FNV-1a 64 over its FHIR JSON as
   `FhirResourceSchema` encodes it, fields in schema order, as sixteen hex
   digits. So every adopted resource has an id (`adoptResource` returns
   `FhirResourceWithId`), and a re-import of the same capture lands on the same
   one. Such a resource skips step 3: the source gave it no id, so no
   identifier claims one, and it keeps only the identifiers it arrived with
   (`originalIdOf` reads `null` off it).
2. **Derives the id** from `(system, resourceType, decodedId.value)`.
3. **Prepends one `Identifier`** carrying the source's own id —
   `identifier[0] = { system: <source system>, value: <original id> }`. Every
   identifier the source already wrote is kept, behind it. There is deliberately
   no "already adopted?" guard: adoption runs exactly once per resource, at one
   choke point, so a source that publishes its own base URL as an identifier
   system yields a benign duplicate and nothing worse.
4. **Rewrites references** through the per-type field table below.

The digest leaves `meta` out. `meta` describes the response (`lastUpdated`,
`versionId`), not the record, so a fresh capture of the same id-less record
digests the same. A resource that does not encode is a defect, not a digest of
something else: it means a kind's decode let through what the schema's encode
refuses, and there is no FHIR JSON to digest.

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

Adoption is **one option-less per-kind combinator**, `adoptUnderRecognizedRoot`.
It takes a single `HttpResponseKind<FhirResource>` to a
`HttpResponseKind<FhirResourceWithId>`, replacing its `parse` with one that
adopts the parse output under the identity **the kind's own `tryRecognize`
mints for the response's URL** — read verbatim from
`kind.tryRecognize(response.url, response.method).source`, with no source
passed in. `RecognizedUrlData.source` is `SourceIdentity`'s shape, spelled
structurally in `http-extraction-fundamentals`, which stays FHIR-free. Each
kind constructs its own identity, so recognition and the namespace a resource
keys under are the one decision:

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
- **What comes out has an id, typed as the whole union.** `adoptResource` is
  declared `FhirResource → FhirResourceWithId`, because TypeScript cannot
  correlate the variant matched with the branch taken, so the combinator takes
  a kind over the whole `FhirResource` union and returns one over
  `FhirResourceWithId`. Each source package widens its kind list to
  `HttpResponseKind<FhirResource>[]` (a narrower kind satisfies it by
  covariance) before the `.map`, and its `SourceDescriptor` is over
  `FhirResourceWithId`: everything downstream of extraction knows each resource
  has the id it is written under.

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

## The identity map

Adoption keys every resource under its source, so it cannot tell that two
sources name one person. One human with a Shoppers account, a Rexall account
and a LifeLabs report arrives as three Patients, each source's `subject`
pointing at its own; a provider a lab report names and the same provider on a
prescription are two. The importer's **identity map** links them, once per
batch, before anything is reviewed or written. It lives in
`importer-fundamentals` (see its
[AGENTS.md](../../../importer/importer-fundamentals/AGENTS.md)); this section is
the model. A batch runs through three states, one adjective each: **decoded**
(as the files arrived), **resolved** (every link followed, as it will be
written) and **stored** (already on the device).

### Referents and mentions

A **mention** is each place a resource names something by a `Reference`, at
its path: a `subject`, a `requester`, a `performer[0].actor`, a report's
`resultsInterpreter`. An import discovers its **referents**: the things it
refers to that may already exist on the device, one per **linkable logical
reference**, FHIR's logical reference (`type` and `identifier`, no literal)
narrowed to a `Patient` or `Practitioner` and an identifier with both a
`system` and a `value`. A referent comes in one of two kinds:

- **As a resource**: the decode emitted the `Patient` or `Practitioner`
  itself. It is keyed by its `identifier[0]`, the source's own id adoption put
  there, and answers to every identifier it brings: its own, and the one its
  demographics derive (below).
- **By mention only**: mentions name it by a logical reference and no decode
  emitted its resource. A Shoppers account id on a history fill is one; so is
  a prescriber known only by name.

Which type a mention names is the reference's own business. A logical
reference states its `type`; an identifier-only reference that states none
names nothing the map can tell apart from an account number, and a
`display`-only mention names nobody the map can link. A source that knows a
provider only by a printed name therefore writes
`Practitioner.tryReferenceFromName(<name>)` (`tryReferenceWireFromName` when
it builds wire): `type` Practitioner, `Practitioner.nameIdentifier(<name>)` as
the `identifier`, the name as `display`, and no reference at all for a blank
name. The Shoppers prescriber, the Rexall prescriber and the DICOM referring
physician all do. DICOM builds the name from the parsed PN, given names first
and then family, because the PN text prints the family name first and would
never match a prescription's "Jane Smith". LifeLabs writes a `Practitioner`
per provider it prints, so its providers are referents as resources.

### Name-and-birth-date and practitioner-name identifiers

Two identifier systems are Wildflower's, not any source's, so the same identity
from two sources is one identifier. Both sit under `terminology.ts`'s
`WILDFLOWER_IDENTIFIER_SYSTEM_BASE` and are persisted wire format:

- `Patient.NAME_BIRTH_DATE_IDENTIFIER_SYSTEM`: `family;given;YYYY-MM-DD` from
  the name shown for the person (`HumanName.displayName`'s pick) and
  `birthDate`, the given names joined by a space, in NFC, lower-cased,
  whitespace collapsed, the three parts joined on `;` because `|` is the FHIR
  token separator. None unless all three parts are present, so a partial
  match never links two people, and a name change alone never matches.
- `Practitioner.NAME_IDENTIFIER_SYSTEM`: the printed name, trimmed, whitespace
  collapsed, case kept.

Every Patient and Practitioner referent as a resource carries its derived
identifier beside its own once resolved, and the identifier is written with
the resource. A name-and-birth-date match is therefore an ordinary identifier
match, and a person whose name changed keeps both spellings on the device.

### Link choices and link targets

The reviewer makes one **link choice** per referent:

- **Create** the resource: the referent's own resource is written and becomes
  the person or provider. For a referent by mention only, allowed only when
  its logical reference stands for something **provisional**: a provider's
  printed name stands for a `Practitioner` carrying the name and the
  identifier, at `localResourceId(NAME_IDENTIFIER_SYSTEM, 'Practitioner',
  name)`, so the same name from two sources is one record that later imports
  add to. Nothing stands for a Patient: a person named only by an id is linked
  to a record or left unlinked.
- **Update the stored resource**: the referent's own resource is written over
  the stored copy under its own literal reference, keeping every identifier
  the copy assumed. What a re-import does.
- **Link to a stored resource**: a resource of that type already on the
  device.
- **Link to a decoded referent** of its type in the batch, for a referent by
  mention only: it lands wherever that one lands.
- **Don't link**, for a referent by mention only: its mentions keep their
  logical-reference form.

Each referent's default comes from one identifier search
(`GET <Type>?identifier=`) over the identifiers its source gave it, then the
derived one: a hit that is the stored copy of its own resource is an update,
one hit is a link to it, two hits are ambiguous and no hit falls back to the
kind's default, Create with a resource and Don't link without. The reviewer
always sees every referent and can change it.

A choice resolves to a **link target**: a stored resource, the referent's own
decoded resource, a provisional resource, or unlinked. Every mention of the
referent, literal or logical, is redirected to that target, keeping its
`display` and `identifier`. A decoded Patient or Practitioner linked to a
stored one is replaced by it under the same review key, so the review, the
server diff and the confirm all see the resource that is written. The records
the batch only mentions, stored or provisional, are the batch's **linked
records**, written beside the files, once however many files mention them.

### Mention link choices

A reviewer may also choose for one mention of one resource, over whatever its
referent's choice says: link it to a stored resource, to a decoded referent
(so it follows that referent's later link), or don't link it. A mention link
choice is held in the identity map beside the referent choices and resolved
by the same plan, never written into the resource as an edit; it teaches
nothing and writes nothing. A resource whose `subject` lands on no patient of
the device, or whose mention is a logical reference the map left unlinked, is
listed for the reviewer under **Needs a patient** or **Needs a provider**,
and a resource with no patient is left out of the import until it is given
one.

### What a link target assumes

A link target's resource **assumes** the identifiers of every referent linked
to it, as one assumes an identity: they are appended to the stored or decoded
resource, and nothing else about it changes. A stored resource's demographics
win; a source's spelling of a name or birth date is not written over them.
Because the stored resource now carries the source's identifier, the next
import of the same source finds it by that identifier and defaults to
updating or linking to it.

The map applies to the batch being imported. Resources already on the device
from earlier imports are not re-linked: the Patients earlier imports wrote stay
separate records, and the resources filed on them keep pointing at them.
Linking a referent to one of them adds identifiers to that record; it merges
nothing into it.

## References

- [http-extraction AGENTS.md](../../../http-extraction/AGENTS.md) — the
  response-kind / source-descriptor vocabulary the per-source packages build on.
- [har-importer-core AGENTS.md](../../../importer/har-importer-core/AGENTS.md) —
  the importer that runs the pre-adopted kinds over a HAR.
- [web-trace-core AGENTS.md](../../../web-trace-core/AGENTS.md) — the codec that
  mints trace ids.
- [importer-fundamentals AGENTS.md](../../../importer/importer-fundamentals/AGENTS.md)
  — the identity map's phases and guardrails.
