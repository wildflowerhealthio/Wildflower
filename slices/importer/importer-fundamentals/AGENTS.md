# AGENTS.md — slices/importer/importer-fundamentals

The **format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-resource
staged-import model (what a decoded-but-unwritten import consists of), the
identity map that links a decode's patients and providers to the device's, and
the structural failure record the sinks report against. It is the
layer a concrete binding (`har-importer-core`, `lifelabs-pdf-importer-core`)
sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell drives.

## Shape

- `src/file-importer.ts` — **`FileImporter.Type<TSettings, TFormat>`**, "a
  file-format importer" as one first-class value a closed registry lists:
  `format`, `display`, `detect`, `defaultSettings`, the format's `decode`,
  `sourceFileFormat` (the format's `PickedFile.FormatValue` — its `coding` /
  `contentType` / `securityLabel` / `descriptionPrefix`, the last spelled by
  the binding, conventionally `` `${display.title}: ` ``), and the optional
  `linkSourceFile` and `linkToSourceFiles` hooks. **An interface and nothing
  else**: a binding writes the value as a **literal**, because every
  field is either a constant it states or a function it already has, and
  `decode` comes from `DecodeFunction.make`. A `FileImporter` is a **plain
  record, not a class instance**: an adapter layer extends one by spreading it
  (which is how `importer-react`'s registry attaches a format's
  `SettingsPicker`), and a spread is only total when there is no prototype to
  lose. The **write direction is not a field**: minting the source file a
  picked file is stored as is something only `importer-core`'s import stage does, through
  `PickedFile`'s own codec, under the importer's `sourceFileFormat`. What a
  reader of the server's source-file list needs — `PickedFile.categoryToken`,
  `PickedFile.isSourceFile`, `PickedFile.FromDocumentReference` — it gets by
  applying those to the same `sourceFileFormat`, which is why that value is
  spelled **once** per binding. Two optional hooks sit beside it, both run by
  the import stage, one each way between a set's source files and its
  records. **`linkSourceFile(sourceFile, adopted)`** makes a source file name
  the records read out of it: it runs once per picked file of a set, with that
  file's source file, as minted, and the set's records, adopted, and returns
  the source file to list and stamp with (its `id` must not change; left out,
  the source file is stored exactly as minted). **`linkToSourceFiles(resource,
  sourceFiles)`** makes a record name the source files it was read from: an
  effect run over every adopted record of the set once its source files are
  linked, with each **`PickedSourceFile`** (`{ pickedFile, sourceFile }`) of
  the set, and returning the record to write (left out, every record is kept
  as it is). A record matches a source file by the source file's
  `masterIdentifier`, what its picked file identified itself as
  (`DecodedFileSet.PickedFileIdentity`), since the decode that built the
  record never saw a source file; DICOM sets each `ImagingStudy` instance's
  `gridfsFileId` there. A record naming a file no source file of the set
  identifies as fails with **`SourceFileNotFound`**, which the import stage
  reports as an unreadable row per picked file of the set. An
  `UnreadableFile`'s `error` is that or a decode's `ParseError`.

- `src/format-detector.ts` — the **`FormatDetector`** namespace: **`Type`**
  (`{ format, detect }`, the two fields it takes to claim a picked file) and
  **`claiming(detectors, file)`** (the first detector whose `detect` claims it,
  returned at the caller's own element type). The detection seam, held apart
  from `FileImporter` because the picker and `importer-core`'s `readBatch` need
  it **without** needing the format: neither reads a `decode`, a
  `defaultSettings` or a codec, and neither should have to name the settings
  type of a format it is only sniffing. A `FileImporter.Type` satisfies it
  structurally, so the registry's values pass straight through.
- `src/settings-picker-props.ts` — **`SettingsPickerProps<TSettings>`**, the
  `{ settings, onChange }` contract a format's settings picker renders
  against (a format whose settings are `null` has none), below every format's
  React package. Its own module rather than a member of `file-importer.ts`: it
  describes a _component_, not the importer value.
- `src/format-decode.ts` — the **`FormatDecode`** namespace: **`Decoded<K>`**
  (what a format's `decode` returns: its files, its **`DecodedFileSet`**s
  apart, and its **`UnreadableFile`** rows), **`makeUnreadableFile`** (the
  row one pick is reported as), **`titleOf`** (the title a format's picks are
  reported under), and the identity derivations every id and review key is
  built from.
  All three read a picked file's **`id`** — minted once, over the whole batch in
  pick order, by `importer-core`'s `readBatch`, so two picks of the same name
  (two `report.pdf`s out of two folders) stay distinct and a settings re-decode
  yields the same ids. **`makeId`** names one format's picks, **`makeFileId`**
  one pick among them, and **`keyPrefix`** is the namespace every review key of
  one file set carries: the import stage builds each row's review key as the
  prefix of the set's first picked file before the record's local key, which
  is what keeps a fixed local key like DICOM's `patient`, or HAR's per-archive
  `har-entry-<index>`, from colliding across the file sets one format claimed.
- `src/sectioned-list.ts` — the **`SectionedList`** namespace: the one
  container every stage of an import carries its records in. **`Type<E>`** is
  `{ sections }`, each a `Section.Type<E>`. **`map`**, **`modify`** and
  **`forEach`** (the `Effect` traversal) work row by row;
  **`rows`** flattens; **`groupBy`** sections rows by title in the order each
  first appears; **`make`**, **`empty`**, **`concatenateAll`**, **`prepend`**
  and **`append`** build. Section order is
  meaning (a set's source files first, its implied records last), so nothing
  reorders sections or merges two that share a title. `modify`, the
  same-typed `map`, keeps reference identity: a section `f` changed nothing in
  comes back as itself, and so does
  a list none of whose sections changed, which `FileResolution.resolveRows`
  and the review's memoized rows rely on.
- `src/section.ts` — the **`Section`** namespace: **`Type<E>`**, one titled
  group of rows `{ title, rows }`, and **`make(title, rows)`**.
- `src/file-set-record.ts` — the **`FileSetRecord`** namespace: **`Type`**,
  one record of a file set `{ localKey, resource }`, read from the set or
  implied by it, not yet given an id. `resource` is the record **detached**
  (`fhir-r4-adoption`'s `DetachedResource`: no id, keyed by its first
  identifier, naming every other record of the set by a logical reference).
  `localKey` is the decoder's stable name for the record within its set: it
  only has to be unique within the set and stable across a settings
  re-decode, and its one job is to become the record's review key, which the
  import stage builds from it (`DecodedFileSet.adopt`).
- `src/review-row.ts` — the **`ReviewRow`** namespace: **`Type`**, one record
  as the review addresses, titles and writes it,
  `{ reviewKey, title, isImplied, resource }`: the `reviewKey` the reviewer's
  ticks and edits, the server diff and the link choices index by, the `title`
  the review shows it under, `isImplied` (the import built the record from a
  reference to a record no file of its set holds; the import stage's
  source-file rows and the identity map's linked records are not implied),
  and the record it will write, with the id it is written under.
- `src/adopted-file-set.ts` — the **`AdoptedFileSet`** namespace: **`Type`**,
  one file set's records made the device's own, the import stage's output for
  one set: its **`sectionedList`**, a `SectionedList.Type` of `ReviewRow`,
  beside its `notes`; **`concatenateAll`** (every set's sections in order, and
  every set's notes).
- `src/decoded-file-set.ts` — the **`DecodedFileSet`** namespace: one file
  set as its format decoded it. **`Type`** is exactly what a format's
  `decodeFileSet` returns: its `pickedFiles` (read together, in the order
  they were picked, never empty), its **`sectionedList`**, a
  `SectionedList.Type` of `FileSetRecord`, and its `notes`.
  Each picked file is a **`PickedFileIdentity`**: the file beside
  `identifiedAs`, the FHIR `Identifier` its own content names it by (DICOM's
  SOP Instance UID as `urn:oid:`), or `None` for a format whose files do not
  name themselves; the import stage writes it onto the file's source file as
  `masterIdentifier`. **`unidentified(pickedFile)`** is a picked file
  identifying as nothing, which HAR and LifeLabs give for each of theirs. A
  decoder builds one section per report, study or response URL and writes or
  detaches its own records, so a section carries no source base URL or
  system. The "Source file(s)" section is the import stage's own, never
  decoded. **`writtenReferenceTitle(plan, reviewKey)`** is every decoded
  record's review title, read off its `ResourcePlan`: for a `Derived` plan
  the literal reference the import stage writes it under, `<Type>/<id>`, or
  `<Type> (<reviewKey>)` for a `Minted` one, whose id changes on every
  re-decode; `adopt` titles each row with it, so no decoder titles its
  records.
  **`adopt(decoded, keyPrefix, mintId?)`** is how the import stage makes a
  file set's records the device's own: given the set's `sectionedList` and
  `notes` and the prefix every review key of the set starts with, an Effect
  of an `AdoptedFileSet` failing with the `ParseError` an implied record's
  schema rejects it with, in five named steps. It plans every record
  (`planRecords`: `ResourcePlan.make`, each plan kept beside its record in a
  `PlannedRecord` `{ record, plan, isImplied }`, none implied). It implies
  the records the set's references name and no record of the set is
  (`impliedSectionOf`, a pipeline over the planned records' references,
  `ResourceReferences.collect`: each logical reference,
  `LogicalReference.tryFromReference`, that has a `display` and whose target
  no record of the set holds by any identifier, `ReferencePlan.holds`,
  implies one record per distinct logical reference, built by
  `ImpliedRecord.tryFromLogicalReference` from the first reference to name
  it, under the local key `ImpliedRecord.localKeyOf` gives, planned by
  `ResourcePlan.derived` from the reference's own identifier, and implied),
  in a section of their own titled `Implied records`, the last of the set's
  sections, added only when the set implies a record. It builds the set's
  `fhir-r4-adoption` `ReferencePlan` from the `Derived` plans
  (`referencePlanOf`; one entry for each qualified identifier of a keyed
  record, its key and every other, each resolving to its plan's literal
  reference: the one place that decides which identifiers resolve; a keyless
  record's identifiers stay out) and puts it in force
  (`Effect.provideService` of `ReferencePlan.InForce`, so every adoption step
  reads it from the environment and none takes it as a parameter), then runs
  `fhir-r4-adoption`'s `adopt` over each record with its plan's `id`
  (`adoptRecords`, over `SectionedList.forEach`), each a `ReviewRow` keyed
  by `keyPrefix` before the record's local key and keeping whether it is
  implied. So a keyed record lands on the id its key derives, a keyless one
  on an id `mintId` mints (a random UUID unless a test injects one), in
  record order, and a logical reference resolves when
  the set holds a keyed record it names by any of that record's identifiers,
  whichever section holds it, as a FHIR server resolves a conditional
  reference against a transaction bundle; one naming a record the set does
  not hold, a keyless one, or an identifier two records of the set share
  (`ReferencePlan`'s ambiguous case; a record listing one identifier twice
  is no clash), stays logical, for the identity map. Since the set holds every record it
  implies, a provider a source names only by a printed name, or a Rexall prescriber carebook names as
  `Practitioner/<id>` and never serves, is a row of its own, and every
  reference to it resolves to it. Before adopting, a
  `MedicationDispense` with no `subject` (`takeSubjectFromPrescription`) takes its authorizing
  prescriptions' `subject`, as they spell it, when they agree: every
  `authorizingPrescription` resolving (`ReferencePlan.literalReferenceIfResolved`)
  to a keyed `MedicationRequest` of the set has a copy whose `subject` names a
  Patient of the set (copies naming none are skipped), and every copy that
  names one names the same Patient; otherwise it is left with no `subject`.
  A dispense that has a `subject` keeps it, whatever it names: it is the
  source's own statement of who received the fill. It is how a source that
  knows who a prescription is for, but not who a fill was for, files the
  fill. The format decode tests adopt through it too.
- `src/implied-record.ts` — the **`ImpliedRecord`** namespace: the record a
  reference names when no record of its file set is that record, built from
  what the reference says of it.
  **`tryFromLogicalReference(logicalReference, display)`** reads an
  exhaustive table over `fhir-r4`'s `FhirResource` of an `Option` of an
  **`ImpliedRecordMaker`** per type: a `Patient` or `Practitioner`'s maker
  builds its `identifier` and one `name` whose `text` is the display,
  decoded detached (`DetachedResource.decodeUnknownEither`), so it gives the
  record or the `ParseError` its schema rejects it with; every other type
  has none, its row stating the R4-required elements a reference cannot
  carry (a `MedicationRequest`'s `subject` among them, so a Shoppers
  history-only fill's `authorizingPrescription` stays logical). A type the
  table does not list (one `fhir-r4` does not model) implies none too.
  **`localKeyOf(referencingLocalKey, logicalReference)`** is
  `<referencingLocalKey>#implied:<Type>|<system>|<value>`, only a key: stable
  across a settings re-decode, and unique within the set since the
  referencing record's local key is. Nothing reads it back; a row says it is
  implied by its `isImplied`.
- `src/resource-plan.ts` — the **`ResourcePlan`** namespace: where one
  decoded record is written, decided before any record of its set is
  adopted, as a FHIR server decides each transaction entry's id before
  rewriting the references between them. **`Type`** is **`Derived`**
  (`{ resourceType, id, identifier }`: a keyed record, the same location on
  every import, its `id` `localResourceId(key.system, Type, key.value)` and
  its `identifier` its key alone, `[identifier[0]]` as a
  `QualifiedIdentifier`, so a `Derived` plan is the `LogicalReference` to its
  record)
  or **`Minted`** (`{ resourceType, id }`: a keyless record, a new location
  every import), matched with `ResourcePlan.match`.
  **`derived(resourceType, identifier)`** is the plan of a record keyed by
  `identifier`, its id derived there, once; **`make(resource, mintId)`** plans
  one record, `derived` from its key or minting a keyless one's id; an implied
  record's plan is `derived` from the identifier of the reference that
  implies it. **`literalReference(plan)`** is `<Type>/<id>`.
- `src/decode-function.ts` — the **`DecodeFunction`** namespace: a format's
  decode's signature **and the one constructor that builds it**. **`Type`** is
  the signature a `FileImporter` exposes (files and settings in, one
  `FormatDecode.Decoded` out, never failing, requiring `R`: `never` for a
  format that reads its bytes itself, a platform service such as
  `positioned-text`'s `PositionedTextExtractor` for one that cannot).
  `FileImporter.Type` carries the same `R`, and `make` takes it from the
  `Config`'s `decodeFileSet`.
  **`make(config)`** takes one **`Config`**: the `format`, a `decodeFileSet`
  (the picked files of one set in, a `DecodedFileSet.Type` out, as the import
  stage receives it: its `pickedFiles`, each paired with what it identifies
  as, `DecodedFileSet.unidentified` for a format whose files do not name
  themselves; its records in sections under their local keys; and its
  notes), and — optionally — a `groupBy`. **`groupBy`** is called per
  file and returns the key it shares with its set-mates, or a `Left` that
  reports it as its own `unreadableFiles` row (in the order the files were
  picked, ahead of any failing set); left out, every file is its own set, keyed
  by its own id. A format that needs a parse to state that key **parses
  twice** — once here, once in `decodeFileSet` — which is the
  deliberate price of a constructor with no parsed-value passthrough in it.
  Per set, concurrently across sets, `make` runs `decodeFileSet` and folds a
  `ParseError` into one `unreadableFiles` row per picked file of the failing
  set. It returns each set apart, with its picked files and its records under
  their local keys, because `importer-core`'s import stage builds each set's
  source files and review keys and sets its records' `meta.source`.

- `src/staged-import.ts` — the **`StagedImport`** namespace, the pure per-resource
  selection model. A `Selection` holds only what the reviewer did, on two
  axes: `includedByReviewer` (their own include/exclude choices, `true` or
  `false` by a row's `reviewKey`; a key absent there takes the
  default the shell derives and passes in as `excludedByDefault`) and
  `resourceOverrides` (per-resource inline edits over `FhirResourceWithId`, same
  keying — the reviewer's edited resource, resolved on the batch's plan
  (`FileResolution.resolveEdit`), replaces the resolved original at
  confirm). `initial` / `toggleResource` / `setResourcesIncluded` (the
  many-key form of `toggleResource`, so the shell can opt a whole section in or out at
  once) / `edit` / `revert` are the transitions;
  `isResourceIncluded` / `isResourceEdited` / `editedResource` /
  `resolvedResourceOf` (the resource the review writes for a resolved row)
  the reads,
  which `importer-core`'s `planWrite` folds, row by row, into the confirm's
  write set — no re-parse at confirm, the reviewed (or edited) objects are
  what gets written. Orphaned selection entries
  (keys a re-decode no longer produces) are inert — sets and maps of keys,
  nothing dangling.
- `src/identity-map/` — the **identity map**: for every referent an import
  discovers, what it links to on the device, the one search that defaults it,
  and the phases that resolve a batch's decoded rows on those choices, each
  pure or an Effect whose only input besides its arguments is the clock
  (which of a person's names is current). One namespace per file, one phase
  each; `importer-core`'s `resolveMentions` runs them over a batch. Three
  states run through the names, one adjective each:
  - **decoded** — as the file arrived: a review group's rows as the import
    stage made them, their referents and mentions as the source wrote them.
  - **resolved** — every link followed, as it will be written: rows resolved
    on their batch's link plan (`FileResolution.resolveRows(plan,
    sectionedList)`), the resource under a resolved literal reference
    (`ResolvedResource`).
  - **stored** — already on the device: what a referent search finds and a
    link choice links to or updates.

  Making links (`Link.fromChoices`, the reviewer's choices into link targets)
  is not resolving: resolving follows the links once they are made. A
  conversion between the model's types says its direction:
  `tryFrom<Source>` builds the namespace's type, `tryInto<Target>` leaves it;
  an `Option` whose `None` is one nameable fact is `<thing>If<condition>`
  (`resourceIfLinked`, `redirectionIfLinked`, `resolvedResourceIfReferent`);
  `maybe` is only for an attribute that may be absent.
  - **`LinkableLogicalReference`** — `fhir-r4`'s `LogicalReference` (what a
    `Reference` names its target by when it has `type` and `identifier` and
    no literal `reference`: `{ resourceType, identifier: [identifier] }`, the
    identifier a `QualifiedIdentifier`, one with a `system` and a non-empty
    `value`) narrowed to `resourceType: 'Patient' | 'Practitioner'`. What an
    identifier-only mention carries and what a resource's `resourceType` +
    `identifier[0]` answer to; the map keys it by `LogicalReference.key` and
    compares it by `LogicalReference.equivalence`. `tryFromReference` narrows
    `LogicalReference.tryFromReference`, `isLinkable` the narrowing itself.
    Nothing about linking.
  - **`LinkableResource`** — a `Patient` or `Practitioner`, the types a
    referent can have a resource for: `is` (a decoded resource as one, its
    `id` already set), `tryIntoLogicalReference` (its `identifier[0]`), `maybeDisplayName`
    (`HumanName.displayName`'s pick among its names, judged at the clock's
    `DateTime.now`, so an Effect), `maybeDerivedIdentifier` (an exhaustive
    match: `Patient.nameBirthDateIdentifier` for a Patient, none for a
    Practitioner, whose name alone identifies no one across sources) and
    `labelOf`, both Effects for the same reason, `isDerivedIdentifier`
    (whether an identifier is under that Wildflower system rather than a
    source's), `literalReferenceOf`, `sameRecord` (whether two are copies of
    one record: the same `Type/<id>`), and
    **`assumesIdentifiers`**, which appends the qualified identifiers a
    resource does not already carry, assumed as one assumes an identity, and
    changes nothing else.
  - **`Mention`** — each place a resource names something by a `Reference`,
    at its path (`subject`, `performer[0].actor`): **`madeIn`** is every
    mention a resource makes, found by fhir-r4's
    `ResourceReferences.collect` so a reference anywhere is one; `at` the one
    at a path; `hasEmptySubject`, whether a `subject` slot holds nothing;
    and `isRelativeLiteral`, whether a reference is a relative literal
    `Type/<id>` (not a contained `#<id>`, an absolute URL, or text). Which
    type an identifier-only mention names is the reference's own business: a
    logical reference states its `type`, and one that does not names nothing.
    **`linkableIn`** is every mention a reviewer may choose a link for on its
    own (a **`Linkable`**, the mention with its `type`): each that names a
    type the map links, by `type` or by its relative literal, plus, for a
    `subject` that states none, a `Patient` (FHIR's Patient
    CompartmentDefinition names `subject` for every type the importer
    handles), an empty `subject` slot included as an empty reference;
    `linkableTypeOf` is that type, and **`emptySubject`** an empty `subject`
    slot as a linkable mention. **`relinkedLiteral`** is the literal a
    relinked mention is written with: the one given, or, for `None`, `null`,
    its literal dropped, unless the mention would then name nothing, when it
    is left. **`relinked`** is the resource with the mention at a path
    relinked so (`ReferenceRewrite.apply`), keeping its `identifier` and
    `display`; it fills an empty `subject` slot, which no rewrite reaches.
  - **`Referent`** — a Patient or Practitioner the import holds a record
    of, which may already exist on the device, once per identity: its
    decoded `resource` (keyed by its `identifier[0]`), carrying every
    identifier a search tries, its own and the derived one, its row's
    `reviewKey` and whether it `isImplied`, and its `label`. Every referent
    has a record: a reference to one the import never saw implies it at
    decode (`DecodedFileSet.adopt`). `ownLogicalReferencesOf` is the logical
    references a referent's source-given identifiers make (a derived
    identifier a resolved resource carries is not among them),
    `maybeDerivedLogicalReferenceOf` the one its demographics derive,
    `logicalReferencesOf` both: every logical reference a referent answers
    to. A logical reference names the referent it is the key of, else the one
    referent that answers to it, so a health card number a decoded Patient
    also carries is that Patient. **`discover(decodedRows)`** finds them over
    a batch's decoded rows, once per identity (a record two file sets imply
    under one id is one referent, and a copy a file decoded is taken over an
    implied one by `isImplied`), and fails with **`DuplicateReferent`** when two resources
    under different ids, in one file or two, share a key; `byKey` indexes
    into a `HashMap`. A referent's **`key`** is its `LogicalReference.Key`,
    so every map by referent takes no other string.
  - **`LinkChoiceSet`** — the reviewer's whole answer (**`Type`**,
    `{ byReferent, byMention }`; `empty`): what the screen holds and a batch
    is resolved on.
  - **`ReferentLinkChoiceSet`** — the link choice set by referent
    (**`Type`**, a `HashMap` of every referent's `LinkChoice` by
    `Referent.key`; `empty`). **`forReferent(byReferent, referent)`** reads a
    referent's choice off it, else **`DEFAULT_CHOICE`**, `CreateResource`;
    `union` lays one set's choices
    over another's and `remove` drops a referent's choice.
  - **`MentionLinkChoiceSet`** — the link choice set by mention: the
    reviewer's choice for one mention of one resource, over whatever its
    referent's choice says (**`Type`**, a `HashMap` by
    **`key(reviewKey, mentionPath)`**; `empty`, `set`, `forMention`). A
    mention's own choice is a `LinkChoice.MentionLinkChoice`:
    `LinkToStoredResource`, `LinkToDecodedReferent` (wherever a referent of
    the import is linked, so a mention picked onto a referent's own record
    follows the referent when it is later linked to a stored one) or
    `DontLink`, which the review's per-mention selects make. Resolved by the plan, never
    written into the resource as an edit; it teaches nothing and writes
    nothing.
  - **`LinkChoice`** — what the reviewer chooses, a family of imperatives,
    tagged objects built only through their constructors, matched with
    `LinkChoice.match`. A referent's choice (**`Type`**) is
    **`CreateResource`** (its own record written), **`UpdateStoredResource`**
    (its own record written over its stored copy under the same literal
    reference, keeping what the copy assumed: a re-import) or
    **`LinkToStoredResource`** (a resource on the device); the first two are
    a **`WritingLinkChoice`**. A mention's own choice, a
    **`MentionLinkChoice`**, writes nothing: `LinkToStoredResource`,
    **`LinkToDecodedReferent`** (wherever a referent of the import is linked)
    or **`DontLink`**. **`InvalidLinkChoice`** is a referent's choice the
    stage cannot follow, with its `reason`: a stored resource of another
    type, or a stored copy to update under another id than the referent's.
  - **`LinkTarget`** — the resource a referent or a mention is linked to,
    named for where it comes from: **`Stored`**, **`Decoded`** (carrying the
    `storedCopy` it is written over when the choice named one), or, for a
    mention alone, **`Unlinked`**; a **`Linked`** target (`Stored | Decoded`)
    is what every referent is linked to. Matched with `LinkTarget.match`;
    `resourceIfLinked` is the resource its mentions are redirected to, `None`
    when it is `Unlinked`. Every resource-bearing variant carries one with an
    `id`.
  - **`Link`** — a referent with its `Linked` target, what the plan is built
    from; **`fromChoices(referents, linkChoices)`** makes every referent's
    link from its choice, one match with no chain to follow: its decoded
    resource for `CreateResource`, its decoded resource over the stored copy
    for `UpdateStoredResource`, the stored resource for
    `LinkToStoredResource`. The first choice it cannot follow is its failure.
  - **`ResolvedResource`** — the resource under one resolved literal
    reference as it will be written, stored or decoded: its
    `resolvedLiteralReference`, the copy written (the decoded one when a link
    is redirected to it, so a re-import's newer decode wins over the stored
    copy a mention links to; else the last link's) having assumed its
    `identifiersToAssume` (its own derived identifier, then those every other
    copy of it the links carry, a stored copy a mention links to or the one a
    `Decoded` target updates, then those of every referent linked to it: the
    one place a copy's identifiers are carried forward), whether the
    `resourceExistsInBatch` (a resolved row writes it where a decoded
    resource was: one decoded there and not replaced by another stored
    resource, or one a decoded resource is replaced by), its `label`, the
    title of a row it replaces or is appended as, and its
    `ownerReferent`: the referent whose decoded resource it is when the copy
    written comes from a `Decoded` target, `None` when it is a stored
    resource, even one under the id a referent's own record would have.
    **`make`** builds one from the links redirected to a literal reference
    (each a referent and the target holding its resource); **`fromLinks`** groups a batch's links by the
    literal reference they redirect to and makes one per group, in the order
    the links first reach it.
  - **`LinkPlan`** — the theory the identity map is coded to: the reviewer's
    choices become links, the links are the plan, the plan resolves the
    batch, and the screen offers what the plan will write. The plan
    (**`Type`**) holds the **`links`** and the **`resolvedResources`** in
    discovery order, and indexes each question by the key it asks with:
    links by referent key (`Referent.key`), links by every logical reference
    a referent answers to (`Referent.logicalReferencesOf`), the stored
    stand-in by the decoded resource's literal reference (the first in
    discovery order kept), the link target chosen for each mention by
    `MentionLinkChoiceSet.key`, and resolved resources by the literal
    reference each is written under. Outside the module it is read only
    through its questions.
    **`make(decodedRows, byReferent)`** makes the links once per batch over its referents
    (`Referent.discover`), so a referent one file holds is the link target
    of a mention in another, the stand-ins, and the resolved
    resources the links redirect to (`ResolvedResource.fromLinks`);
    **`withMentionLinkChoiceSet(plan, byMention)`** lays on the link target
    each mention the reviewer chose for takes, one `HashMap.filterMap` of
    the link choice set by mention: a `LinkToStoredResource` that stored
    resource, a `LinkToDecodedReferent` its referent's link target (none when
    that referent is not in the batch, so the mention is redirected where its
    own referent's link target says), a `DontLink` `Unlinked`; only an
    explicit `DontLink` unlinks a mention. **`empty`** is the plan of a batch
    with no referent. Its questions, each named for the fact its `None` states:
    **`linkTargetIfReferentKey`** (a referent's link target, when the key is
    a referent of the batch), **`linkTargets`** (every referent's, in
    discovery order), **`redirectionIfLinked`** (where a decoded reference is
    redirected when it names a referent: a literal one to the stored resource standing in for its decoded one, a
    logical one to the link target of the referent it names, the one it is
    the key of, else the one referent that answers to it),
    **`resolvedResourceIfReferent`** (the resource a decoded resource is
    written as when it is a referent: the resolved resource under the literal
    reference it is written under; a resource that is no referent is written
    as decoded), **`linkTargetIfChosenForMention`** (the link target the
    reviewer chose for a linkable mention of the resource under a review key,
    when it is one the mention can take: `Unlinked`, or a resource of the
    type the mention names, so a `subject` is never redirected to a
    Practitioner) and **`resolvedResources`** (every resolved resource).
  - **`FileResolution`** — pure, every function taking the plan first, since
    it is fixed for a batch: **`resolveRows(plan, sectionedList)`** writes
    each decoded resource of a review group's rows (`SectionedList.modify`) as the resolved
    resource `LinkPlan.resolvedResourceIfReferent` has for it, titled by its
    label when it replaces the decoded one under another id, else as decoded,
    its references rewritten either way by one `ReferenceRewrite` per row,
    keeping `display` and `identifier`: each mention the reviewer chose a
    link for under the row's review key where that choice says (on the chosen
    resource's literal reference, or, for `Unlinked`, with its literal
    dropped, `Mention.relinkedLiteral`), over every other reference that
    names a referent, redirected to its link target
    (`LinkPlan.redirectionIfLinked`); an empty `subject` slot chosen for is
    filled;
    **`resolveEdit(plan, reviewKey, editedResource)`**: the reviewer's edit of the row
    reviewed under that key with its mentions redirected the same way, never
    replaced by a resolved resource, so an edit naming a decoded record a
    stored one now stands in for, or a mention chosen for, is written where
    the plan says now;
    **`linkedRecords(plan)`**: the batch's linked records, the resolved
    resources no resolved row holds, each a `ReviewRow`
    (a decoded record whose id a stored record,
    linked to under another of the record's keys, stands in for in every
    file), as they will be written, keyed by **`linkedKey`**, titled by
    their label and not implied, in the order the links first reach them, no
    file's and so no format's.
  - **`UnlinkedMention`** — **`leftByReferentLinks(plan, reviewKey,
    resource)`**: what the plan's referent links leave unlinked in one
    resource as decoded or edited, never as resolved (the plan says where its
    references would be redirected): the resource as
    **`OutsidePatientCompartment`** (a `subject` slot that is empty or names
    neither a patient of the device by a relative literal nor someone the map
    could link; FHIR's Patient CompartmentDefinition names `subject` for
    every type the importer handles), and every **`Dangling`** mention (a
    linkable logical reference, in any field, that no link redirects), matched with `UnlinkedMention.match`. Only the
    plan's links are read, so a mention link leaves a row listed.
  - **`ReferentSearch`** — the identity map's one server read, over
    `fhir-r4/clients`' `FhirR4ResourcesHttpApiClient`: **`defaultChoice`** is
    a `GET <Type>?identifier=&_count=2` with the referent's own logical
    references (`Referent.ownLogicalReferencesOf`) as `TokenSearchParam`
    tokens and, only when that names nothing, a second with the derived one
    (`maybeDerivedLogicalReferenceOf`), so a record this source wrote is
    found ahead of a namesake; a hit that is the stored copy of the
    referent's own decoded resource (same literal reference: a re-import) is
    `UpdateStoredResource`, whatever else was found, or `LinkToStoredResource`
    for a referent that `isImplied`, which would write only what a
    reference said over the copy; otherwise the one hit is
    `LinkToStoredResource`, two hits are ambiguous and no hit is
    `ReferentLinkChoiceSet.DEFAULT_CHOICE`, so the reviewer chooses; the hits are the
    searchset's matches (an `outcome` entry is not one), a match without its
    resource fails the read as **`MatchWithoutResource`**, and a failed
    search fails the read. **`defaultChoices`** runs it per
    referent, a few at a time, into the `ReferentLinkChoiceSet` a review
    starts from (#1431 is one search per type).
  - **`DifferingDemographics`** — **`between(decoded, stored)`**: the
    demographics (a **`Demographic`**, `FamilyName | GivenName | BirthDate`)
    a decoded resource and the stored resource it is linked to both state and
    differ, compared on `Patient.demographics` at the clock's now, in the
    order a warning lists them; a Practitioner compares none. What the review
    warns about; the link stands.
  - **`ReferentTally`** — **`make(linkTargets)`**: how many records the
    referents are linked to (`onServer`, `fromImport`, each record counted once, a
    stored record the import writes over counted from the import): the
    review's summary line.

- `src/picked-file.ts` — the **`PickedFile`** namespace: the picked file
  vocabulary _and_ the codec that source files one. **`Type`**
  (`{ id, fileName, bytes }`) is the one value every `decode` receives, and
  **`NamedBytes`** (`{ fileName, bytes }`) the id-free half it extends — one
  name for the shape a picker source, `FormatDetector.claiming` and the read of
  a stored source file all take, instead of three structural copies of it. Bytes
  rather than text so the picker stays format-blind. The `id` is the batch slot
  `importer-core`'s `readBatch` stamped, and **the picker never mints one**.
  The codec is one schema over one format's **`FormatValue`**, which reaches it
  as the **`Format`** `Context.Tag`: **`FromDocumentReference`**, whose read leg
  accepts only a source file of this format carrying attachment data (so a rejected
  source file reports through the schema's own issue) and projects it — stored id,
  attachment title, decoded bytes — and whose write leg **mints**: SHA-256 of the
  bytes, an id from `fhir-r4/identity`'s `localResourceId` over that hash plus
  the file name namespaced by the coding system, and the resource built around
  them. The encode ignores the value's own `id`, so decoding a source file and
  encoding it again is the identity on the id — which is what makes a file
  re-picked off the server mint the source file it came from rather than a second
  copy. The source file states **no instant**: what it is, not when it arrived; the
  server's own `meta.lastUpdated` is what dates a row.
  **`categoryToken`** and **`isSourceFile`** are plain projections of the
  constants — not codec work, so not schemas. **`SourceFile`** is the codec's
  encoded side, a `DocumentReference` with the id it is stored under
  (`WithMandatoryId<DocumentReference.Type>`): what the mint yields and the read
  leg accepts, a `DocumentReference` with no id being no stored source file.
  Note the internal `DocumentReferenceAsItself` is a `Schema.declare` over that
  type rather than
  `Schema.typeSchema(DocumentReference.Schema)`, whose encode walks the struct
  and turns a `null` optional into `undefined`.
- `src/sha256.ts` — **`sha256Base64`** (+ `DigestUnavailable`), the base64
  SHA-256 the source file attachment's `hash` carries, over Web Crypto. A verbatim
  copy of `web-trace-core`'s helper (the standard digest, no project-specific
  behaviour), kept here so the codec above needs no `web-trace-core` dependency
  — a copy, because moving it would invert the importer → web-trace direction.

## Layering

Depends on `effect` (and `kitchen-sink` in tests), `fhir-r4-adoption` for
`DetachedResource`, `ReferencePlan` and `adopt` alone (a
`FileSetRecord`'s record, `ResourcePlan`'s keys,
`DecodedFileSet.adopt` and the records `ImpliedRecord` builds; it depends on no importer package), plus `fhir-r4` for the
`DocumentReference` schema and the `Identifier` a picked file identifies itself
as, `fhir-r4/resources` for
`FhirResourceWithId` (`review-row.ts` and `staged-import.ts` are concrete over
it, not generic — every format binds it, so there is no `TParsed` left to
abstract over; a reviewed resource always has the id it is written under), for the `Patient` and `Practitioner` schemas an implied record decodes through, and for the identity map's `Patient`, `Practitioner` and
`ResourceReferences`, its one reference walk, `fhir-r4/data-types` for `Meta`
(the slot `MetaSource.stamp` writes into) and the identity map's
`IdentifierAndReference` and `HumanName`, `fhir-r4/identity` for the shared id
derivation, and `fhir`'s wire types. Hosting the source file codec is what widened
`fhir-r4` from a type-only import to the `DocumentReference` runtime schema
(it builds and decodes the resource). `ReferentSearch` reads through
`fhir-r4/clients`' `FhirR4ResourcesHttpApiClient` as an Effect requirement; the
shell provides the layer. No `persistResources`: the write sink stays at the
shell (`fhir-r4/clients`' `persistBatchBundle`). It deliberately does **not** depend
on `web-trace-core`: the digest helper (`sha256.ts`) and `meta-source.ts` are
both verbatim-in-spirit copies of web-trace's, for the same reason — standard,
project-neutral helpers, and moving them would invert the importer →
web-trace direction. A HAR binding passes web-trace's coding constants in as
data. Names no source file _format_ (each binding supplies its `decodeFileSet` and
its coding), no HTTP vocabulary (the HAR binding's recognition machinery lives in
`har-importer-core`), and no UI framework. Never imports a `*-importer-core`,
an `importer-core`, a `*-importer-react`, or anything of `slices/http-extraction`
but `fhir-r4-adoption`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes the `Included` decisions of
  `importer-core`'s `planWrite` — the same objects, the exclusions applied and
  the edits substituted — with no re-parse. This split is the whole point; do
  not collapse it.
- **Sections and notes are the whole review surface.** A format's per-import
  knobs (the LifeLabs and DICOM time zones) are _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **`importer-core`'s import stage provides `PickedFile.Format`; the shell
  provides it at its one read; no other production code does.** The codec is
  parameterized by that tag, the import stage discharges it once per format
  from the importer's `sourceFileFormat`, and `importer-react`'s read of a stored source file
  (`fetchSourceFile`) provides it from the registry entry's own
  `sourceFileFormat`. See "Bake an internal context requirement to reshape the
  public type" in the
  [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md).
  A new source file operation belongs in `picked-file.ts` requiring the tag,
  not in a wrapper closing over `coding`.
  This is also what keeps **`sourceFileFormat` spelled once** per binding: a
  second copy could hand the import constants that disagree with the ones a
  reader of the server list searches and recognizes by, and nothing would catch
  it.
- **`decode` never fails.** Malformed input is an `unreadableFiles` entry, not
  an error channel: a decode constructor folds the `ParseError` into the file
  it belongs to (one row per pick of the failing set), so one bad file in a
  batch leaves the rest reviewable and nothing above this
  package needs a `catchAll`.
- **Nothing here is re-exported twice.** A symbol has one route: `index.ts`
  exposes each module as its namespace, and a flat re-export beside it would
  give the same symbol a second spelling. Only modules that are _not_
  namespaces (`sha256.ts`, `settings-picker-props.ts`) export flat.
- **The source file is the format's, minted by the import stage.** What a
  source file is, which resources point at it, and what happens to those links
  are each format's decisions, expressed through its importer's
  `sourceFileFormat`, `linkSourceFile` and `linkToSourceFiles` over the `picked-file.ts`
  vocabulary and codec; `importer-core`'s import stage runs them. The shell has
  no source file knowledge at all — it reviews the minted row like any other
  resource. Do not put the mint in the shell or in a decode.
- **Review keys are namespaced per file set, in the import stage and nowhere
  else.** A `decodeFileSet` gives local keys unique within _one_ set, because
  that is all it can see; a review group merges the sections of every file
  set its format read, while the selection, the server-diff verdicts and the
  write plan are each keyed by review key within its review group.
  `DecodedFileSet.adopt` builds each review key as the prefix of the set's
  first picked file (`FormatDecode.keyPrefix`) before the local key, which is
  what makes a fixed local key safe. Do not push that obligation down into a
  `decodeFileSet` — one that tries to be unique across its format's file sets
  cannot be, since it is given one set.
- **Identity is the map's, never the selection's.** `StagedImport` keeps
  exclusions and edits; where a mention is redirected lives in the
  `ReferentLinkChoiceSet` and, for a mention the reviewer chose for on its own,
  the `MentionLinkChoiceSet`, held beside the selections, and `importer-core`'s
  `resolveMentions` runs over the batch before the server diff, the preview
  and the confirm, so all three see the resources that get written: one
  `LinkPlan.make` over the batch's decoded rows, the mention links laid on
  it (`LinkPlan.withMentionLinkChoiceSet`), every review group's rows
  resolved on it once (`FileResolution.resolveRows(plan, sectionedList)`),
  the batch's linked records off it (`FileResolution.linkedRecords(plan)`).
  Resolving is a function of its arguments and the clock, and keeps every
  group's sections and keys. A batch's decoded rows are resolved on one plan
  over the batch's referents: the choices are made for the decoded rows'
  referents, and a referent one file holds is the link target of a mention
  in another. Resolving the resolved rows again on the same choices changes nothing when they have the
  same referents: no mention several decoded resources answer
  to, and no mention a linked stored resource answers to, since once resolved
  one resource answers to each of those mentions. A referent's mentions are
  redirected to its link target: a decoded resource linked to a stored
  resource is replaced by it **under the same review key**, titled by its
  label, the stored resource assuming the referent's identifiers and its own
  derived one and keeping its demographics byte for byte; every mention of
  the referent, a literal `Type/<decoded id>` or a logical reference, is
  redirected by the row's reference rewrite (`ReferenceRewrite.apply`),
  keeping its `display` and `identifier`; a resolved resource no resolved file holds (a decoded record
  whose id a stored one stands in for under another key) is one of the
  batch's **linked records**, held once for the batch and in no file, so the
  review shows it and the identifiers it assumed; a decoded resource that is its referent's link target is
  written as decoded plus its derived identifier and those of the referents
  linked to it. On a re-import the referent's own search finds the stored
  copy under the decoded id and defaults to `UpdateStoredResource`, which
  resolves the decoded resource having assumed every identifier the stored
  copy carries, whether or not a mention links to that copy, so what it
  assumed in earlier imports is written again; `CreateResource` on such a
  referent writes the decode without them. Every referent is resource-backed:
  a record the import only names by reference is implied at decode
  (`DecodedFileSet.adopt`), so a provider known by a printed name is a
  `Practitioner` keyed in its source's own name system, and one name from two
  sources is two records until the reviewer links them. A stored resource of
  another type, or a stored copy to update under another id, fails the stage
  with `InvalidLinkChoice`, and so do two decoded resources under different
  ids keyed by one identity, in one file or two (`DuplicateReferent`): errors
  bubble to the screen rather than read as a default.
  `UnlinkedMention.leftByReferentLinks` lists, for a resource as decoded or
  edited, whether it is outside every patient's compartment (a `subject` slot
  in which nothing names a patient of the device or someone the map could
  link) and every dangling mention: a logical reference, in any field, the
  map could link and its referent links leave unlinked. A `display`-only provider,
  an untyped identifier, an absolute URL and a contained `#<id>` are not ones
  the map could link, so they are not listed on their own. A mention link
  choice wins over its referent's rule for that one mention; only an explicit
  `DontLink` unlinks one, and a choice of a type the mention cannot name, or
  of a referent the batch does not hold, is none.
- **Selection keys by a row's `reviewKey`.** Selection state must
  be serializable and survive a settings re-decode, so both axes hold string
  keys; a key that disappears simply stops applying.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that builds on this contract.
- [importer-core AGENTS.md](../../../slices/importer/importer-core/AGENTS.md) — the closed registry
  and the batch machinery built on this contract.
- [importer-react AGENTS.md](../../../slices/importer/importer-react/AGENTS.md) — the shell that
  drives the `StagedImport` transitions over each format's review.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
