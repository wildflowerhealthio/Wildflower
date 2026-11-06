# Source Identity Explanation

Why an imported resource is not stored under the id its source gave it, what
replaces that id, and how an import links the patients and providers its
sources name to the ones already on the device. The derivation is `fhir-r4`'s
(`fhir-r4/identity`); detaching a decoded resource from its source and
adopting it into the store under that derivation are this package's; the
identity map is `importer-fundamentals`', stated here as a model.

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

Every imported resource with a key is stored under a **derived local id**:

```text
localResourceId(system, resourceType, sourceId) → "wf-<32 lowercase hex>"
```

It lives in `fhir-r4/identity` and is two 64-bit FNV-1a lanes over the three
components, concatenated. The lane itself is `kitchen-sink`'s `fnv1a64` — the
standard algorithm, pinned in `fnv1a.test.ts` against the published FNV test
vectors, so "it is the standard implementation" is a checked fact rather than a
claim. What stays in `fhir-r4/identity` is what is _not_ standard FNV: the second
lane's displaced offset basis, the 128-bit concatenation, and the `wf-`
rendering.

Properties that matter:

- **Synchronous.** Adoption, and a review title computed from a key, stay
  runnable with `Effect.runSync`; Web Crypto's digest is async and would force
  every decode path to be async too.
- **Non-cryptographic is fine.** Nothing here defends against an adversary
  choosing colliding ids; the derivation only has to be stable and
  collision-resistant against ordinary source ids.
- **Always a legal FHIR id.** `wf-` plus 32 hex is 35 characters of
  `[A-Za-z0-9\-.]`, whatever went in.
- **The resource type is an input**, which is what separates Rexall's
  request/dispense pair.
- **The system is an input**, which is what keeps two servers apart.

The `wf-` prefix is fixed rather than per-source. Source attribution lives in the
identifier, not in the id.

### The components are length-prefixed, not delimiter-joined

`joinIdComponents` renders the three components as `${length}:${value}`
concatenated — `1:a7:Patient3:abc` — rather than joining them on a separator.

A separator is only unambiguous if no component can contain it, which is a
precondition on every caller rather than a property of the function: with a
`\n` join, `('a', 'b\nc', 'x')` and `('a\nb', 'c', 'x')` would both spell
`a\nb\nc\nx` and collide outright. Nothing on a production path reaches such a
pair — the system is a regex-validated root URL plus a type or a minted constant, and
`resourceType` is a union literal or an R4 resource type — but
the function whose job is to make ids unambiguous should not depend on its
callers to be.

`joinIdComponents` is exported because a caller that has to fold more than one
value into a single `originalId` must fold it the same way rather than inventing
a separator. `web-trace`'s `(sessionId, requestId)` pair is one such caller;
nesting is safe, since a joined component is delimited by its own length prefix.

**The function is persisted wire format.** Its output is the primary key a
resource is stored under, so changing the prime, either offset basis, the
component encoding, the field order, or the prefix orphans everything already
stored. `local-resource-id.test.ts` pins exact outputs so that change fails
loudly.

## Detached resources

A decoder hands the import stage **detached resources**: FHIR resources as
they stand outside any server (`DetachedResource` in this package).

- **`id` is `null`.** FHIR's logical id only means something within the
  server that assigned it, so a record read out of a source carries none.
- **Its key is its first identifier.** A record is keyed by
  `(identifier[0].system, resourceType, identifier[0].value)`: the system is
  FHIR's `Identifier.system`, the namespace the value is unique in, an
  absolute URI. A record with no identifier, an unqualified first one (no
  `system` or no `value`), or no `identifier` element at all (`Binary`) is
  **keyless**.
- **Every reference to another decoded record is a logical reference**:
  `{ reference: null, type: '<TargetType>', identifier: { system, value } }`,
  the target named by its key.

`DetachedResource.keyOf` reads a record's key.

## Writing a record detached

A decoder that builds its records itself (a portal's synthesis, a file
format's) writes them detached directly, keyed in its own system:
`DetachedResource.keyIdentifierWire(key)` is a record's `identifier[0]`,
`logicalReferenceWire(Type, key)` a reference to another record it decodes,
and `DetachedResource.decodeUnknown(schema)` decodes the wire as a detached
record, failing one that carries an `id`. Shoppers keys each type in the
portal's own namespace for it (`patient-id`, `prescription-id`,
`dispense-id`); Rexall's profile keys its Patient by the profile `uid` in
carebook's Patient system, `<REXALL_STU3_BASE_URL>/Patient`, the key
carebook's searchset names it by. LifeLabs keys each record by a real
identifier in a specific system, never a digest (`LifeLabsIdentifierSystem`):
the Patient by its `Patient ID`, else its health card number in the
province's health card system the import's settings name (`fhir-ca-infoway`'s
`HealthCardIdentifier.FromPrinted`, spaces and hyphens stripped: Ontario's ten
digits less its version code, British Columbia's ten-digit PHN, any other
province's number in a Wildflower-minted system), else its name and date of birth; the `DiagnosticReport` by its
`Lab No` (a page printing none is skipped, and of two reports printing one
only the latest is kept); each result row and each provider in a
Wildflower-minted system over the printed facts. Where a record has no
printed identifier but must be referenced, the system is a fictitious
Wildflower one with a readable value. DICOM keys every type in its one
Wildflower-minted system (`DICOM_SYSTEM`).

## Detaching a server's record

Only a record that really was a FHIR server's, with that server's ids and
literal references, is detached, with
`DetachedResource.fromServerRecord(baseUrl)`: the server's id becomes the key
identifier in `<baseUrl>/<Type>` (`https://example.com/fhir/Patient`), since a
FHIR server's ids are unique per type, and references to the server's own
records become logical. The server may also spell a reference to its own
record absolutely, `<baseUrl>/Type/id`, which reads as the relative
`Type/id`. Carebook is such a server, rooted at its STU3 base
`REXALL_STU3_BASE_URL`. `fromServerRecord(baseUrl)` turns one resource into a
detached one of the same type:

1. **Drops the `id`.**
2. **Keys it by that id.** When the `id` was set and the type has an
   `identifier` element, `{ system: <baseUrl>/<Type>, value: id }` is
   prepended as `identifier[0]`. Every identifier the source already wrote is
   kept behind it. There is deliberately no "already keyed?" guard: a source
   that publishes its own ids as identifiers in the same system yields a
   benign duplicate.
   A `Binary`, and a record with no `id`, keep only what they had, so they are
   keyless unless the source's own first identifier names them.
3. **Turns each literal reference logical**, through the per-type field table
   below.

### The detach reference rule

A reference's target is named in the system of **its own type**, not the
referring record's: a FHIR server's `Observation.subject` of `Patient/abc`
names `(<baseUrl>/Patient, Patient, abc)`. For one `Reference`:

```text
reference.reference is null                                        → unchanged
the literal, less a leading `<baseUrl>/`, does not match
  `^[A-Za-z]+/[A-Za-z0-9\-.]{1,64}$`                               → unchanged
the type token is not an R4 resource type                          → unchanged
otherwise → reference  := null
            type       := Type
            identifier := { system: <baseUrl>/<Type>, value: id }
```

The grammar and type checks are what leave alone, and an unchanged reference
keeps its original spelling, absolute or relative, its `identifier` included:
`#fragment` contained references,
`urn:uuid:`, foreign absolute URLs, version-specific `Type/id/_history/v`
(relative or under the base), search URLs, ids over 64 characters or carrying
a space, a base that is only a prefix of the server's (`https://h/fhir`
against `https://h/fhir/R4/Patient/1`), hyphenated pseudo-types like
carebook's `rexall-pharmacy-location/pharmacy-4821`, and a token that is no
R4 resource type (`fhir-r4`'s `ResourceType`, the whole R4 value set, not the
types this package models), like carebook's `PrescriptionOrder/<id>`: nothing
says which namespace such an id is in, and the identifier the source put on
it is what says what it links to. An R4 type this package does not model
(`Encounter/1`) is detached like any other. A reference that is
already identifier-only (Shoppers' `priorPrescription` by prescription
number) is kept exactly as the source wrote it.

**An identifier the source also put on a literal reference it detaches is
replaced** by the target's key. `Reference.identifier` is 0..1 and the logical
reference needs it; the target carries its own identifiers, so what it knows
of itself is not lost when it is decoded too. Shoppers' history feed writes the
prescription number on a fill's `MedicationRequest/<id>` link, and the number
stays on the request.

## Adopting a detached resource

The import stage stores each detached record with `adopt`, which takes no
base URL or system: everything it needs is on the records, the id each is
stored under, and the batch's reference plan.

The batch is one file set, and before adopting any of its records the import
stage (`importer-fundamentals`' `DecodedFileSet.adopt`) plans each one where
it is written: its **resource plan** (`importer-fundamentals`'
`ResourcePlan`), kept beside its entry.

- **A keyed record** is `Derived`: stored under
  `localResourceId(key.system, resourceType, key.value)`, the derivation
  above, so a re-import of the same record lands on the same id. Its plan
  derives it once, and carries the key as a qualified identifier.
- **A keyless record** is `Minted`: stored under an id minted for it, a random
  UUID (`randomResourceId`, injected so a test can count). A re-import of it
  is a second record.

From those plans it builds the batch's **reference plan** (`ReferencePlan`,
here): for each resource type and qualified identifier, the literal reference
a logical reference by them resolves to. The reference plan is a plain data
structure that holds what it is given; which identifiers go in is the import
stage's choice, and it puts in every qualified identifier of each keyed
record, its key and every other, each resolving to the literal reference its
record is written under, as a FHIR conditional reference matches a record by
any of its identifiers. A keyless record's id is minted at import, so it puts
nothing in for one, whatever identifiers it carries.

`adopt(referencePlan)(record, id)` stores `record` under the id its resource
plan gave it, and resolves each logical reference through the reference plan,
by the reference's type and its own qualified identifier:

- **A logical reference the reference plan resolves** becomes the literal
  reference the plan gives it, its `type` and `identifier` kept:

```text
reference.reference is null, type is an R4 resource type, identifier has a
system and a value, and the reference plan names exactly one literal
reference for that type, system and value → reference := that literal reference
otherwise                                 → unchanged
```

The reference plan matches on the type and the identifier's `system` and
`value` alone; `use`, `type`, `period` and the rest do not name what an
identifier identifies. It reads a literal reference it already holds, so a
reference whose target is not in the batch costs no hash. Two entries for one
type and identifier with different literal references make that identifier
**ambiguous**, and it resolves to nothing: as a FHIR conditional reference
that matches several records is an error, except that here the reference
stays logical rather than failing the import. The same entry given twice is
not ambiguous.

This is a FHIR server processing a transaction bundle: a conditional reference
resolves against the bundle's own entries, and one that matches none of them
stays as it is. So a reference to a record the source never served — a Rexall
request's `Practitioner/<id>`, a FHIR `Observation`'s `Encounter/1` — stays
logical, and so does a logical reference by an identifier no keyed record of
the batch carries (an account number, a provider's printed name, a
prescription number), or by one two of its records share. They
are left for the importer's identity map (below), and nothing is written that
points at an id nothing is stored under. A reference to a **keyless** record
stays logical too, whichever of its identifiers it names it by.

One record is filed before it is adopted. A source can know who a
prescription is for and not who one of its fills was for: Shoppers' history
feed names only the account, so its fills have no `subject`. A
`MedicationDispense` with no `subject` takes the `subject` of its
`authorizingPrescription`, as the prescription spells it, when its
prescriptions agree: every prescription it names that resolves to a
`MedicationRequest` of the batch has a copy whose `subject` names a Patient of
the batch (a copy that names none is skipped), and every copy that names one
names the same Patient. Otherwise it is left with no `subject`. A dispense
that has a `subject` keeps it, whatever it names and whether or not it
resolves: it is the source's own statement of who received the fill.

`originalIdOf(system, resource)` reads the source's id back off a stored
resource: the value of its identifier in `system` (`<baseUrl>/<Type>` for a
FHIR server's record, not the base). Anything that needs the source's id after
import (to build a source-server URL, say) reads it there, never off
`resource.id`. `adoptedReferenceOf(system, Type, id)` is the literal
reference the import stores the record with that key under, spelled as
`adopt` resolves one, for a resource written outside that source that must point at what
its import stores (a synthetic lab result filed on the Patient a
pharmacy import made); `fhir-r4/resources`' `withSubject` files such a
resource on it.

### Reference field table

`fromServerRecord` and `adopt` walk a resource's references through one
per-type table, `mapReferences`:

| Resource             | Fields walked                                                                                                                                                                                                                                                                                                                                                             |
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

`mapReferences` dispatches with `Match.exhaustive` over the closed `FhirResource`
union, so a resource type added to the union without a row is a compile error
rather than a resource whose references silently keep the source's literals.

The list is explicit rather than a structural walk, so what gets rewritten is
readable and reviewable. `adopt-resource.test.ts` guards it from both sides:

- It diffs the _complement_ of this table on generated resources, through
  both `fromServerRecord` and `adopt`, so a field touched **outside** it
  fails.
- It walks each resource schema's own AST for every path that declares a
  `Reference`, and asserts that set is exactly the walked paths. So a
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

Note the variant preservation inside `mapReferences` is real but unchecked: each
row maps a variant to itself **by construction**, and a row that returned a
different variant would compile. That is stated on the function.

### Never touched

`contained` (raw passthrough JSON — a decoded `Identifier` injected there writes
`null`s onto the wire), `extension` / `modifierExtension` including any
`valueReference` inside them, `meta.source`, `Identifier.assigner`,
`groupIdentifier`, and `Attachment.url`.

`meta.source` is not a rewrite site because the importer's import stage
(`importer-core`'s `importDecoded`) sets it to a reference to the source-file
`DocumentReference` after adopting, whatever the source wrote there.

## Where a record becomes detached

Every response kind yields detached records, so a record is detached inside
the decoder that read it, and nothing downstream carries a source's base URL
or systems:

- **HAR sources.** The source packages' kinds are
  `HttpResponseKind<DetachedResource.Type>`; `har-importer-core`'s preview
  routes and parses, and holds what the kind yields.
  - **FHIR** — `fhir-r4-source`'s kinds are `FhirServerResponseKind.make`
    declarations, whose `parse` detaches each record under the root the
    kind's own `UrlMatch` captures off the response's URL, so a record keys
    in `<baseUrl>/<Type>` of the URL it arrived on.
  - **Rexall** — the medication-list kind detaches carebook's searchset from
    `REXALL_STU3_BASE_URL`; the profile kind writes its Patient detached in
    `REXALL_STU3_PATIENT_SYSTEM`, the system the searchset's subjects name.
  - **Shoppers** — every kind writes its records detached, in the portal's
    own systems (`ShoppersIdentifierSystem`).
- **File formats.** `lifelabs-pdf-importer-core` and `dicom-importer-core`
  synthesize their records detached, keyed by what the file prints and naming
  one another by logical reference.

`importer-core`'s import stage then adopts every record of a file set
(`DecodedFileSet.adopt`), knowing nothing of any source.

## web-trace mints its own ids, at its codec

A trace's id is minted by `web-trace-core`'s `traceResourceId`, the single
definition of that encoding:

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

## Two id shapes, no guards

A stored resource's id is either the derivation over its key (`wf-` and 32
hex) or, for a record its source gave nothing to key it by, a random UUID.
Nothing reads an id to learn which: a record's key, when it has one, is its
`identifier[0]`. Detaching and adopting each run exactly once per record, at
one choke point each, so there is deliberately no "already detached?" or
"already adopted?" guard: such a guard has to guess, and the type says it
instead (`DetachedResource` has no id).

## The identity map

A record's key is its source's identifier for it, so adoption cannot tell
that two sources name one person. One human with a Shoppers account, a Rexall account
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
  itself. It is keyed by its `identifier[0]`, its key, and answers to every
  identifier it brings: its own, and the one its demographics derive (below).
  A keyless one names nothing the map can link, so it is written as it is.
- **By mention only**: mentions name it by a logical reference and no decode
  emitted its resource. A prescriber known only by name is one.

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
  the importer that runs the source kinds over a HAR and detaches what they
  parse.
- [web-trace-core AGENTS.md](../../../web-trace-core/AGENTS.md) — the codec that
  mints trace ids.
- [importer-fundamentals AGENTS.md](../../../importer/importer-fundamentals/AGENTS.md)
  — the identity map's phases and guardrails.
