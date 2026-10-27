# AGENTS.md — slices/importer/importer-fundamentals

The **format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-resource
staged-import model (what a decoded-but-unwritten import consists of), the
identity map that links a decode's patients and providers to the device's, and
the structural failure record the sinks report against. It is the
layer a concrete binding (`har-importer-core`, `lifelabs-pdf-importer`)
sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell drives.

## Shape

- `src/file-importer.ts` — **`FileImporter.Type<TSettings, TFormat>`**, "a
  file-format importer" as one first-class value a closed registry lists:
  `format`, `display`, `detect`, `defaultSettings`, the batch `decode`, and
  `sourceFileFormat` (the format's `PickedFile.FormatValue` — its `coding` /
  `contentType` / `securityLabel` / `descriptionPrefix`, the last spelled by
  the binding, conventionally `` `${display.title}: ` ``). **An interface and
  nothing else**: a binding writes the value as a **literal**, because every
  field is either a constant it states or a function it already has, and
  `decode` comes from `DecodeFunction.make`. A `FileImporter` is a **plain
  record, not a class instance**: an adapter layer extends one by spreading it
  (which is how `importer-react`'s registry attaches each format's
  `SettingsPicker`), and a spread is only total when there is no prototype to
  lose. The **write direction is not a member**: minting the source file a pick is
  stored as is something only the batch `decode` does, through `PickedFile`'s
  own codec. What a reader of the server's source-file list needs —
  `PickedFile.categoryToken`, `PickedFile.isSourceFile`,
  `PickedFile.FromDocumentReference` — it gets by applying those to the
  importer's `sourceFileFormat`, which is why that value is spelled **once**
  per binding and handed to `DecodeFunction.make` from the same constant.

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
  `{ settings, onChange }` contract every format's settings picker renders
  against, below every format's React package. Its own module rather than a
  member of `file-importer.ts`: it describes a _component_, not the importer
  value.
- `src/format-decode.ts` — the **`FormatDecode`** namespace: **`Result<K>`**
  (one format's whole decode — its id, title, files, merged `DecodedFile` and
  **`UnreadableFile`** rows), **`emptyResult`** for a format that claimed
  nothing, and the identity derivations every id and review key is built from.
  All three read a picked file's **`id`** — minted once, over the whole batch in
  pick order, by `importer-core`'s `readBatch`, so two picks of the same name
  (two `report.pdf`s out of two folders) stay distinct and a settings re-decode
  yields the same ids. **`makeId`** names a whole batch, **`makeFileId`** one
  file within it, and **`keyPrefix`** is the namespace every review key decoded
  out of one file set carries — which is what keeps a fixed key like DICOM's
  `patient`, or HAR's per-archive `har-entry-<index>`, from colliding across the
  files one format claimed.
- `src/decode-function.ts` — the **`DecodeFunction`** namespace: the batch
  decode's signature **and the one constructor that builds it**. **`Type`** is
  the signature a `FileImporter` exposes (files and settings in, one
  `FormatDecode.Result` out, never failing, requiring nothing).
  **`make(config)`** takes one **`Config`**: the `format`, the
  `sourceFileFormat`, a `decodeFileSet`, and — optionally — a `groupBy` and an
  `linkSourceFile`. **`WithSourceFile`** is what a `decodeFileSet` reads: a
  `PickedFile.Type` plus the `DocumentReference` minted for it. **`groupBy`** is
  called per file and returns the key it shares with its set-mates, or a `Left`
  that reports it as its own `unreadableFiles` row (pick order, ahead of any
  failing set); left out, every file is its own set, keyed by its own id. A
  format that needs a parse to state that key **parses twice** — once here, once
  in `decodeFileSet` — which is the deliberate price of a constructor with no
  parsed-value passthrough in it. **`linkSourceFile`** runs after the decode, once per
  member, with that member's minted source file and the set's whole decode, and
  returns the source file to list and stamp with; its `id` must not change. Left
  out, the source file is stored exactly as minted.
  Per set, concurrently across sets, `make` mints a source file for **every** pick
  (`Schema.encode(PickedFile.FromDocumentReference)`), runs `decodeFileSet`,
  finishes each source file through `linkSourceFile`, **namespaces the decode's review
  keys** by the set's first picked file (`FormatDecode.keyPrefix`), stamps every
  resource's `meta.source` with the set's **representative** — the member whose
  source file id is lexicographically smallest, and a source file id is a content hash,
  so the stamp is independent of pick order (`MetaSource.stampDecoded`) —
  prepends the source files as the set's **"Source file"** / **"Source files"**
  section, and folds a `ParseError` into one `unreadableFiles` row per pick of
  the failing set. It provides the `PickedFile.Format` service from
  `config.sourceFileFormat` internally, so nothing it returns carries a
  requirement.

- `src/staged-import.ts` — the **`StagedImport`** namespace, the pure per-resource
  selection model. A `Selection` is two axes: `excludedResources`
  (per-resource opt-outs, keyed by a `DecodedFile.Resource`'s `key`) and
  `resourceOverrides` (per-resource inline edits over `FhirResource`, same
  keying — the reviewer's edited resource replaces the decoded original at
  confirm). `initial` / `toggleResource` / `setResourcesIncluded` (the batch
  form of `toggleResource`, so the shell can opt a whole section in or out at
  once) / `edit` / `revert` are the transitions;
  `isResourceIncluded` / `isResourceEdited` / `editedResource` the reads;
  `chosenResources` folds a flat labeled list through the exclusions and
  edit overrides into the confirm's write set — no re-parse at confirm, the
  reviewed (or edited) objects are what gets written; `includedCount` /
  `excludedCount` drive the shell's tallies. Orphaned selection entries
  (keys a re-decode no longer produces) are inert — sets and maps of keys,
  nothing dangling.
- `src/identity-map/` — the **identity map**: for every referent an import
  discovers, what it links to on the device, the one search that defaults it,
  and the stage that places a batch's decoded files on those choices, an
  Effect whose only input besides its arguments is the clock (which of a
  person's names is current). One
  namespace per file, one phase each. Three tenses run through the names:
  **decoded** (as the file arrived), **placed** (after the map, as it will
  be written) and **stored** (already on the device). A conversion between
  the model's types says its direction:
  `tryFrom<Source>` builds the namespace's type, `tryInto<Target>` leaves it;
  `maybe` is only for an attribute that may be absent.
  - **`LinkableLogicalReference`** — FHIR's logical reference (a `Reference`
    that names its target by `type` and `identifier` rather than a literal
    `reference`), narrowed to `type: 'Patient' | 'Practitioner'` and a
    `QualifiedIdentifier` (fhir-r4: an `Identifier` with a `system` and a
    non-empty `value`). What an identifier-only mention carries and what a
    resource's `resourceType` + `identifier[0]` answer to; its map **`key`**
    `type|system|value`, `equivalence`, `tryFromIdentifier`,
    `tryFromReference`. Nothing about linking.
  - **`LinkableResource`** — a `Patient` or `Practitioner`, the types a
    referent can have a resource for: `tryIntoWithId`,
    `tryIntoLogicalReference` (its `identifier[0]`), `maybeDisplayName`
    (`HumanName.displayName`'s pick among its names, judged at the clock's
    `DateTime.now`, so an Effect), `maybeDerivedIdentifier` (an exhaustive
    match: `Patient.nameBirthDateIdentifier`, `Practitioner.nameIdentifier` of
    the displayed name) and `labelOf`, both Effects for the same reason,
    `isDerivedIdentifier` (whether an identifier is under one of those
    Wildflower systems rather than a source's), `literalReferenceOf`,
    **`tryProvisionalFrom`** (the resource a logical
    reference alone can stand for, provisional until a fuller one arrives: a
    provider's printed name stands for a `Practitioner` through
    `Practitioner.tryFromNameIdentifier`; nothing stands for a `Patient`), and
    **`assumesIdentifiers`**, which appends the qualified identifiers a
    resource does not already carry, assumed as one assumes an identity, and
    changes nothing else.
  - **`Mention`** — each place a resource names something by a `Reference`,
    at its path (`subject`, `performer[0].actor`), found by fhir-r4's
    `ResourceReferences.collect` so a reference anywhere is one; and
    `landsOnDevice`, whether a reference is a relative literal `Type/<id>`
    (not a contained `#<id>`, an absolute URL, or text). Which type an
    identifier-only mention names is the reference's own business: a logical
    reference states its `type`, and one that does not names nothing.
  - **`Referent`** — something the import refers to that may already exist on
    the device, once per identity: **`AsResource`** when the decode emitted
    its resource (keyed by its `identifier[0]`, carrying every identifier a
    search tries, its own and the derived one), **`ByMentionOnly`** when only
    mentions name it; built only through its constructors, matched with
    `Referent.match`. `ownLogicalReferencesOf` is the logical references a
    referent's source-given identifiers make (a derived identifier a placed
    resource carries is not among them), `maybeDerivedLogicalReferenceOf`
    the one its demographics derive, `logicalReferencesOf` both: every
    logical reference a referent answers to; and **`byLogicalReferenceKey`**
    is the referent each
    logical reference names: the one it is the key of, else the one referent
    that answers to it, so a Shoppers account id a decoded Patient also
    carries is that Patient. `tryFromDecodedResource` and `mentionedIn` read
    them off one decoded resource; **`discover`** finds both over a batch's
    files, resources first, once per identity, so a person one file decodes
    and another only mentions is one referent, and fails with
    **`DuplicateReferent`** when two resources under different ids, in one
    file or two, share a key; `byKey` indexes into a `HashMap`.
  - **`ReferentLinkChoices`** — the map itself (**`Type`**, a `HashMap` of
    every referent's `LinkChoice` by `Referent.key`; `empty`): what the screen
    holds and the stage places a file on.
  - **`LinkChoice`** — what the reviewer chooses for a referent, a family of
    imperatives: **`CreateResource`**, **`UpdateStoredResource`** (the
    referent's own resource written over its stored copy under the same
    literal reference, keeping what the copy assumed: a re-import),
    **`LinkToStoredResource`** (a resource on the device),
    **`LinkToDecodedReferent`** (another referent of the import),
    **`DontLink`**; tagged objects built only through their constructors,
    matched with `LinkChoice.match`. `forReferent` reads a choice off the
    referent link choices with its default, `CreateResource` with a resource
    and `DontLink` without. **`InvalidLinkChoice`** is a choice the stage
    cannot follow for its referent, with its `reason`.
  - **`LinkTarget`** — the resource a referent is linked to once
    `LinkToDecodedReferent` is followed, named for where it comes from:
    **`Stored`**, **`Decoded`** (carrying the `storedCopy` it is written
    over when the choice named one), **`Provisional`**, **`Unlinked`**,
    matched with `LinkTarget.match`; `tryIntoResource` is the resource its
    mentions are redirected to. Every resource-bearing variant carries one
    with an `id`, so a resource-backed referent requires one
    (`Referent.tryFromDecodedResource`).
  - **`Link`** — a referent with its link target, what the plan is built
    from; `tryIntoLinkedResource` is the link as a **`LinkedResource`** (the
    referent and the resource its target holds) when the target holds one.
  - `resolution.ts` (**`Resolution`**, not exported) — `linksOf`: every
    referent's choice followed to its link target, each referent resolved
    once, every rule an arm of `LinkChoice.match` or `Referent.match`; the
    first choice it cannot follow is its failure.
  - **`PlacedResource`** — the resource under one placed literal reference as
    it will be written, whatever its origin: the copy written (the decoded
    one when a link lands on it, so a re-import's newer decode wins over the
    stored copy a mention links to; else the last link's) having assumed its
    `identifiersToAssume` (its own derived identifier, then those every other
    copy of it the links carry, a stored copy a mention links to or the one a
    `Decoded` target updates, then those of every referent linked to it: the
    one place a copy's identifiers are carried forward), whether the
    `resourceExistsInBatch` (a placed file writes it where a decoded resource
    was: one decoded there and not moved to another stored resource, or one
    a decoded resource is replaced by), and its `label`, the title of an
    entry it replaces or is appended as. **`make`** builds one from the
    linked resources under a literal reference; `byPlacedLiteralReference`
    groups a plan's links and makes each.
  - **`LinkPlan`** — `make(decodedFiles, linkChoices)`: everything the
    placement needs, worked out once per batch over its referents
    (`Referent.discover`), so a `LinkToDecodedReferent` naming a
    referent one file holds resolves from a mention in another: the
    **`links`**, the **`linkTargetsByLogicalReferenceKey`**, the
    **`placedResourcesByPlacedLiteralReference`**, and the
    **`decodedLiteralReferencesToStored`** (`Type/<decoded id>` →
    `Type/<stored id>` for every decoded resource a stored one stands in for),
    all `HashMap`s. Read through its two lookups, named for the questions the
    later phases ask: **`maybeRedirectOf`** (where a decoded reference is
    redirected, a literal one through the redirects and a logical one through
    its referent's link target) and **`maybePlacedResourceFor`** (the resource
    a decoded resource is written as: the placed resource under the literal
    reference its own is redirected to).
  - **`Placement`** — `place`, pure: each decoded resource of one file
    written as the resource `LinkPlan.maybePlacedResourceFor` has for it,
    else kept (`DecodedFile.mapResources`), titled by the stored resource's
    label when one replaces it, its mentions redirected to their referents'
    link targets either way (`ResourceReferences.map`, keeping `display` and
    `identifier`); **`linkedResources`**: the batch's linked records, the
    resources it only mentions as they will be written, keyed by
    **`linkedKey`** and titled by their label, in discovery order, no file's
    and so no format's.
  - **`UnlinkedMention`** — `collect`: on a placed file, every resource
    **`OutsidePatientCompartment`** (a `subject` slot in which nothing lands
    on a patient of the device; FHIR's Patient CompartmentDefinition names
    `subject` for every type the importer handles) and every **`Dangling`**
    mention (a logical reference, in any field, the map could link and left
    unlinked), matched with `UnlinkedMention.match`.
  - **`ReferentSearch`** — the identity map's one server read, over
    `fhir-r4/clients`' `FhirR4ResourcesHttpApiClient`: **`defaultChoice`** is
    a `GET <Type>?identifier=&_count=2` with the referent's own logical
    references (`Referent.ownLogicalReferencesOf`) as `TokenSearchParam`
    tokens and, only when that names nothing, a second with the derived one
    (`maybeDerivedLogicalReferenceOf`), so a record this source wrote is
    found ahead of a namesake; a hit that is the stored copy of the
    referent's own decoded resource (same literal reference: a re-import) is
    `UpdateStoredResource`, whatever else was found; otherwise the one hit is
    `LinkToStoredResource`, two hits are ambiguous and no hit is
    `LinkChoice.defaultFor`, so the reviewer chooses; the hits are the
    searchset's matches (an `outcome` entry is not one), a match without its
    resource fails the read as **`MatchWithoutResource`**, and a failed
    search fails the read. **`defaultChoices`** runs it per
    referent, a few at a time, into the `ReferentLinkChoices` a review
    starts from (#1431 is one search per type).
  - **`DifferingDemographics`** — **`between(decoded, stored)`**: the
    demographics (a **`Demographic`**, `FamilyName | GivenName | BirthDate`)
    a decoded resource and the stored resource it is linked to both state and
    differ, compared on `Patient.demographics` at the clock's now, in the
    order a warning lists them; a Practitioner compares none. What the review
    warns about; the link stands.
  - **`ReferentTally`** — **`of(linkTargets)`**: how many records the
    referents land on (`onServer`, `fromImport`, each record counted once, a
    stored record the import writes over counted from the import) and how
    many referents are `unlinked`: the review's summary line.
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
  constants — not codec work, so not schemas. A validated `DocumentReference` is
  **not** named here as a type of its own: a module that needs it imports
  `DocumentReference` from `fhir-r4/resources`. Note the internal `DocumentReferenceAsItself`
  is a `Schema.declare` over that type rather than
  `Schema.typeSchema(DocumentReference.Schema)`, whose encode walks the struct
  and turns a `null` optional into `undefined`.
- `src/sha256.ts` — **`sha256Base64`** (+ `DigestUnavailable`), the base64
  SHA-256 the source file attachment's `hash` carries, over Web Crypto. A verbatim
  copy of `web-trace-core`'s helper (the standard digest, no project-specific
  behaviour), kept here so the codec above needs no `web-trace-core` dependency
  — a copy, because moving it would invert the importer → web-trace direction.

## Layering

Depends on `effect` (and `kitchen-sink` in tests), plus `fhir-r4` for the
`DocumentReference` schema, `fhir-r4/resources` for
`FhirResource` (`decoded-file.ts` and `staged-import.ts` are concrete over it,
not generic — every format binds `FhirResource`, so there is no `TParsed` left
to abstract over) and for the identity map's `Patient`, `Practitioner` and
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
an `importer-core`, a `*-importer-react`, or `slices/http-extraction`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes `StagedImport.chosenResources` —
  the same objects, filtered by the exclusions, with edits substituted — with
  no re-parse. This split is the whole point; do not collapse it.
- **Sections and notes are the whole review surface.** A format with routing
  decisions (HAR's kind toggles) expresses them as _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **`DecodeFunction.make` provides `PickedFile.Format`; the shell provides it
  at its one read; no other production code does.** The codec is parameterized
  by that tag, the constructor discharges it once from the `sourceFileFormat` it
  was handed, and `importer-react`'s read of a stored source file
  (`fetchSourceFile`) provides it from the registry entry's own
  `sourceFileFormat`. See "Bake an internal context requirement to reshape the
  public type" in the
  [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md).
  A new source file operation belongs in `picked-file.ts` requiring the tag,
  not in a wrapper closing over `coding`.
  This is also what keeps **`sourceFileFormat` spelled once** per binding: a
  second copy could hand the decode constants that disagree with the ones a
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
- **The source file is the format's, minted inside `decode`.** What a source file is,
  which resources point at it, and what happens to those links are each format's
  decisions, expressed through `decode-function.ts`'s constructor over the
  `picked-file.ts` vocabulary and codec. The shell has no source file knowledge at
  all — it reviews the minted row like any other resource. Do not put the mint
  back in the shell.
- **Review keys are namespaced per file set, here and nowhere else.** A
  `decodeFileSet` keys within _one_ set, because that is all it can see; the
  batch merges every claimed file's sections into one format-wide review,
  while the selection, the server-diff verdicts and the write plan are all
  keyed by `(format, key)`. `DecodeFunction.make` prefixes each set's keys with
  its first picked file (`FormatDecode.keyPrefix`), which is what makes a
  fixed key safe. Do not push that obligation down into a `decodeFileSet` —
  one that tries to be unique across a batch cannot be, since it is not given
  the batch.
- **Identity is the map's, never the selection's.** `StagedImport` keeps
  exclusions and edits; what a mention lands on lives in the
  `ReferentLinkChoices`, held beside the selections, and `importer-core`'s
  `resolveMentions` runs over the batch before the server diff, the preview
  and the confirm, so all three see the resources that get written: one
  `LinkPlan.make` over the batch's decoded files, every file placed on it
  (`Placement.place`), the batch's linked records off it
  (`Placement.linkedResources`). Placing is a function of its arguments and
  the clock, and keeps every file's sections and keys. A batch of decoded
  files is placed on one plan over the batch's referents:
  the choices are made for the decoded files' referents, and a referent one
  file holds is the link target of a mention in another. Applied again to
  the placed files it changes nothing when they have the same referents, of
  the same kinds: no `LinkToDecodedReferent` cycle (whose provisional
  resource is a resource there), no mention several decoded resources answer
  to, and no mention a linked stored resource answers to, since once placed
  one resource answers to each of those mentions. A referent's mentions are
  redirected to its link target: a decoded resource linked to a stored
  resource is replaced by it **under the same review key**, titled by its
  label, the stored resource assuming the referent's identifiers and its own
  derived one and keeping its demographics byte for byte; every mention of
  the referent, a literal `Type/<decoded id>` or a logical reference, is
  redirected through `ResourceReferences.map`, keeping its `display` and
  `identifier`; a resource the batch only mentions is one of the batch's
  **linked records**, held once for the batch and in no file, so the review
  shows the identifier it assumed as the batch's own and a stored person
  several files mention is written once; a decoded resource that is its referent's link target is
  written as decoded plus its derived identifier and those of the referents
  linked to it. On a re-import the referent's own search finds the stored
  copy under the decoded id and defaults to `UpdateStoredResource`, which
  places the decoded resource having assumed every identifier the stored
  copy carries, whether or not a mention links to that copy, so what it
  assumed in earlier imports is written again; `CreateResource` on such a
  referent writes the decode without them. A referent named only by mentions may be
  `CreateResource` only when its logical reference stands for something
  provisional (`LinkableResource.tryProvisionalFrom`: a provider's printed
  name, as a `Practitioner` at `localResourceId(system, 'Practitioner', name)`,
  so one name from two sources is one resource); its default stays
  `DontLink`. `LinkToDecodedReferent` follows to the end; a choice a
  referent's kind does not allow, a stored resource or a referent of another
  type, or a referent the batch does not hold fails the stage with
  `InvalidLinkChoice`, and so do two decoded resources under different ids
  keyed by one identity, in one file or two (`DuplicateReferent`): errors
  bubble to the screen
  rather than read as a default. A cycle reads as `CreateResource` for the
  first of its members, in key order, that it places on a resource, so all of
  it lands on one resource.
  `UnlinkedMention.collect` lists, on the placed file, every resource outside
  every patient's compartment (a `subject` slot in which nothing lands on a
  patient of the device) and every dangling mention: a logical reference, in
  any field, the map could link and left unlinked. A `display`-only provider,
  an untyped identifier, an absolute URL and a contained `#<id>` are not ones
  the map could link, so they are not listed on their own.
- **Selection keys by a `DecodedFile.Resource`'s `key`.** Selection state must
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
