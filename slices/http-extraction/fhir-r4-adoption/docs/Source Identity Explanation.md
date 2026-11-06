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
Wildflower one with a readable value. DICOM keys each record by the
identifier its file carries (`DicomIdentifierSystem`): the Patient by its
Patient ID and the ServiceRequest by its Accession Number, each under the URI
its issuer names (HL7 v2's HD-to-URI rule) or a Wildflower-minted system for
an unstated issuer, and the ImagingStudy by its Study Instance UID in
`urn:dicom:uid`.

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
3. **Turns each literal reference logical**, at any depth
   ([the reference walk](#the-reference-walk), below).

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
stored under, and the file set's reference plan.

A file set is adopted as one: before adopting any of its records the import
stage (`importer-fundamentals`' `DecodedFileSet.adopt`) plans each one where
it is written: its **resource plan** (`importer-fundamentals`'
`ResourcePlan`), kept beside its record.

- **A keyed record** is `Derived`: stored under
  `localResourceId(key.system, resourceType, key.value)`, the derivation
  above, so a re-import of the same record lands on the same id. Its plan
  derives it once, and carries the key as a qualified identifier.
- **A keyless record** is `Minted`: stored under an id minted for it, a random
  UUID (`randomResourceId`, injected so a test can count). A re-import of it
  is a second record.

It then adds the records the set's references name and none of its records
is, each planned from the reference that implies it ([Implied records](#implied-records), below).
From those plans it builds the set's **reference plan** (`ReferencePlan`,
here): for each logical reference (`fhir-r4`'s `LogicalReference`, a resource
type and one qualified identifier), the literal reference it resolves to. The reference plan is a plain data
structure that holds what it is given; which identifiers go in is the import
stage's choice, and it puts in every qualified identifier of each keyed
record, its key and every other, each resolving to the literal reference its
record is written under, as a FHIR conditional reference matches a record by
any of its identifiers. A keyless record's id is minted at import, so it puts
nothing in for one, whatever identifiers it carries.

The import stage puts that reference plan in force (`ReferencePlan.InForce`)
while it adopts the set. `adopt(record, id)` stores `record` under the id its
resource plan gave it, and resolves each logical reference through the
reference plan in force, by the reference's type and its own qualified
identifier:

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
reference whose target is not in the set costs no hash. Two entries for one
type and identifier with different literal references make that identifier
**ambiguous**, and it resolves to nothing: as a FHIR conditional reference
that matches several records is an error, except that here the reference
stays logical rather than failing the import. The same entry given twice is
not ambiguous.

This is a FHIR server processing a transaction bundle: a conditional reference
resolves against the bundle's own entries, and one that matches none of them
stays as it is. So a reference to a record the set neither holds nor
implies — a FHIR `Observation`'s `Encounter/1`, a fill's
`authorizingPrescription` by a prescription number the set lacks — stays
logical, and so does one by an identifier two of its records share. They are
left for the importer's identity map (below), and nothing is written that
points at an id nothing is stored under. A reference to a **keyless** record
stays logical too, whichever of its identifiers it names it by.

One record is filed before it is adopted. A source can know who a
prescription is for and not who one of its fills was for: Shoppers' history
feed names only the account, so its fills have no `subject`. A
`MedicationDispense` with no `subject` takes the `subject` of its
`authorizingPrescription`, as the prescription spells it, when its
prescriptions agree: every prescription it names that resolves to a
`MedicationRequest` of the set has a copy whose `subject` names a Patient of
the set (a copy that names none is skipped), and every copy that names one
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

### Implied records

A reference can name a record its source never sends: a provider a pharmacy
label or a lab report knows only by a printed name, or a Rexall prescriber
carebook names as `Practitioner/<id>` and never serves. The reference says
what the record is (its type), who it is (its identifier) and what it is
called (its `display`), which for a person or a provider is a record. So
before it builds the reference plan, the import stage implies that record
(`DecodedFileSet.adopt`'s `impliedSectionOf`):

- Every logical reference of the set (`ResourceReferences.collect`, then
  `LogicalReference.tryFromReference`: typed, by a qualified identifier and
  with no literal) that carries a `display` and whose target no record of
  the set holds by any of its identifiers (`ReferencePlan.holds`) implies
  one record per distinct logical reference, built from the first reference
  to name it.
- `importer-fundamentals`' `ImpliedRecord.tryFromLogicalReference` reads an
  exhaustive per-type table of `ImpliedRecordMaker`s: a `Patient` or
  `Practitioner` is the reference's identifier and one `name` whose `text` is
  the display; every other type has none,
  since R4 requires elements a reference cannot carry (a
  `MedicationRequest`'s `subject`, `status`, `intent` and `medication[x]`,
  for one). So a Shoppers history fill's `authorizingPrescription` by a
  prescription the set lacks stays logical.
- The implied record's local key is
  `<referencing local key>#implied:<Type>|<system>|<value>`, a stable key and
  nothing more. The implied records are reviewed in a section of their own,
  `Implied records`, after the set's decoded sections, and each row says
  it is implied by its `isImplied` (`ReviewRow`).

It is keyed by the identifier of the reference that implies it, so its plan
is `Derived` (`ResourcePlan.derived`) and every reference to it resolves to
it as a literal, as if the source had sent it. The review shows it as a row
of its own, and the identity map treats it as any decoded record.

### The reference walk

`fromServerRecord` rewrites a resource's references with `fhir-r4`'s
`ResourceReferences.mapReferences`; `adopt` with a `ReferenceRewrite` (the
reference plan's, `ReferencePlan.toRewrite`), which gives each reference only
its new literal reference and walks with `mapReferences` too. The import
stage reads them with `ResourceReferences.collect`. It is a structural walk: it finds
every decoded `Reference` by `fhir-r4`'s own `Reference` schema, at any
depth, so `note[].authorReference` (`Annotation.author[x]`, one level down
inside an array), a nested `PlanDefinition.action[].subjectReference`, an
`Identifier.assigner` and an extension's `valueReference` are all reached, and
a `Reference` field added to a resource schema is walked with no edit here.

The walk rebuilds only what a rewrite changed and replaces a `Reference` only
with what the rewrite returns for it, so a resource keeps its own shape; the
type system cannot follow that, so `fromServerRecord` casts back to the
resource's own type once. `adopt-resource.test.ts` diffs every field that
holds no reference on generated resources, through both `fromServerRecord`
and `adopt`, so a field touched outside the references fails, and walks each
resource schema's AST so the list of reference fields it diffs around stays
complete.

### Never touched

`contained` (raw passthrough JSON, in which the walk finds no decoded
`Reference`; a decoded `Identifier` injected there would write `null`s onto
the wire), `meta.source`, and `Attachment.url`.

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
`system` and a `value`. Every referent is a record of the batch: the decode
emitted the `Patient` or `Practitioner`, or the import stage implied it from
a reference ([Implied records](#implied-records)). It is keyed by its
`identifier[0]`, its key, and answers to every identifier it brings: its own,
and the one its demographics derive (below). A keyless one names nothing the
map can link, so it is written as it is.

Which type a mention names is the reference's own business. A logical
reference states its `type`; an identifier-only reference that states none
names nothing the map can tell apart from an account number, and a
`display`-only mention names nobody the map can link. A source that knows a
provider only by a printed name therefore writes
`Practitioner.tryReferenceFromName(<system>, <name>)`
(`tryReferenceWireFromName` when it builds wire): `type` Practitioner,
`Practitioner.nameIdentifier(<system>, <name>)` as the `identifier`, the name
as `display`, and no reference at all for a blank name. The import stage
implies the Practitioner it names. The Shoppers prescriber, the Rexall
prescriber, LifeLabs' ordering and CC'd providers and the DICOM referring
physician all do. DICOM builds the name from the parsed PN, given names first
and then family, because the PN text prints the family name first and would
not read as a prescription's "Jane Smith".

### Name-and-birth-date and practitioner-name identifiers

The name-and-birth-date system is Wildflower's, not any source's, so the same
person from two sources derives one identifier. It sits under
`terminology.ts`'s `WILDFLOWER_IDENTIFIER_SYSTEM_BASE` and is persisted wire
format:

- `Patient.NAME_BIRTH_DATE_IDENTIFIER_SYSTEM`: `family;given;YYYY-MM-DD` from
  the name shown for the person (`HumanName.displayName`'s pick) and
  `birthDate`, the given names joined by a space, in NFC, lower-cased,
  whitespace collapsed, the three parts joined on `;` because `|` is the FHIR
  token separator. None unless all three parts are present, so a partial
  match never links two people, and a name change alone never matches.

Every Patient referent carries its derived identifier beside its own once
resolved, and the identifier is written with the resource. A
name-and-birth-date match is therefore an ordinary identifier match, and a
person whose name changed keeps both spellings on the device. A Practitioner
derives none: a name alone identifies no one across sources.

A practitioner-name system is each source's own, persisted wire format like
any key: `ShoppersIdentifierSystem.PractitionerName`,
`REXALL_PRACTITIONER_NAME_SYSTEM`
(`https://wildflowerhealth.io/fhir/sid/rexall-be-well/practitioner-name`),
`LifeLabsIdentifierSystem.PractitionerName` and
`DICOM_PRACTITIONER_NAME_SYSTEM`. Its value is the printed name, trimmed,
whitespace collapsed, case kept (`Practitioner.nameIdentifier`). The same name
from two sources is two Practitioners until the reviewer links them.

### Link choices and link targets

The reviewer makes one **link choice** per referent:

- **Create** the resource: the referent's own record is written and becomes
  the person or provider. The default when the search finds nothing.
- **Update the stored resource**: the referent's own record is written over
  the stored copy under its own literal reference, keeping every identifier
  the copy assumed. What a re-import does.
- **Link to a stored resource**: a resource of that type already on the
  device.

Each referent's default comes from one identifier search
(`GET <Type>?identifier=`) over the identifiers its source gave it, then the
derived one: a hit that is the stored copy of its own resource is an update,
one hit is a link to it, two hits are ambiguous and no hit falls back to
Create. The reviewer always sees every referent and can change it.

A choice resolves to a **link target**: a stored resource or the referent's
own decoded resource. Every mention of the referent, literal or logical, is
redirected to that target, keeping its `display` and `identifier`. A decoded
Patient or Practitioner linked to a stored one is replaced by it under the
same review key, so the review, the server diff and the confirm all see the
resource that is written. The stored records the batch only links to are the
batch's **linked records**, written beside the files, once however many files
mention them.

### Mention link choices

A reviewer may also choose for one mention of one resource, over whatever its
referent's choice says: link it to a stored resource, to a referent of the
batch (so it follows that referent's later link), or don't link it, which
leaves it unlinked: its literal dropped, its `identifier` and `display`
kept. These are a mention's choices only, which the review's per-mention
selects make. A mention link
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
