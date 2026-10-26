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
  discovers, what it links to on the device, and the pure stage that places a
  decoded file on those choices. One namespace per file, one phase each:
  - **`Identity`** — `{ resourceType: 'Patient' | 'Practitioner', system,
    value }`: who or what an identifier names, as a value; its map **`key`**
    `resourceType|system|value`, `equivalence`, and the conversions to and
    from an `Identifier`. Nothing about linking.
  - **`LinkableResource`** — a `Patient` or `Practitioner`, the types a
    referent can have a resource for: `identityOf` (its `identifier[0]`),
    `derivedIdentifier` (an exhaustive match: `Patient.nameBirthDateIdentifier`,
    `Practitioner.nameIdentifier`), `labelOf`, and **`assumesIdentifiers`**,
    which appends the identifiers a resource does not already carry, assumed as
    one assumes an identity, and changes nothing else.
  - **`Mention`** — each place a resource names its patient or a provider:
    its top-level `subject`, `requester` and `performer`, read by field. An
    identifier-only reference states no type, so the field it is mentioned in
    says whether it names a Patient or a Practitioner; the field is also the
    path an unlinked mention reports, since `ResourceReferences.map` gives
    none.
  - **`Referent`** — something the import refers to that may already exist on
    the device, once per identity: **`WithResource`** when the decode emitted
    its resource (carrying every identifier a search tries, its own and the
    derived one), **`ByMentionOnly`** when only mentions name it.
    **`discover`** finds both, resources first, once per key.
  - **`LinkChoice`** — what the reviewer chooses for a referent: **`New`**,
    **`ToStored`** (a resource on the device), **`SameAs`** (another referent),
    **`DontLink`**; tagged objects built only through their constructors,
    matched with `LinkChoice.match`. `forReferent` reads a choice with its
    default, `New` with a resource and `DontLink` without.
  - **`Destination`** — where a referent ends up once `SameAs` is followed:
    **`OnStoredResource`**, **`OnOwnResource`**, **`OnProvisionalResource`**,
    **`Unlinked`**; `literalOf` is what its mentions are redirected to.
  - **`Provisional`** — `forIdentity`: the resource an identity alone can stand
    for, provisional until a fuller record arrives. An exhaustive match over
    the resource types: a provider's printed name stands for a `Practitioner`
    (`Practitioner.fromNameIdentifier`); nothing stands for a `Patient`.
  - `resolution.ts` (**`Resolution`**, not exported) — `destinationOf`: a
    referent's choice followed to its destination, every rule a `Match` arm.
  - **`LinkPlan`** — `make`: everything the placement needs, worked out once:
    each referent's destination, each stored or provisional resource as it
    will be written and whether it **`existsOnlyAsMentionInFile`**, the
    literal redirects, and what each own resource assumes.
  - `redirection.ts` (**`Redirection`**, not exported) — `redirectMentions`:
    a referent's mentions are redirected to its destination, through
    `ResourceReferences.map`, keeping `display` and `identifier`.
  - **`Placement`** — `place`: each decoded resource replaced by, or written
    alongside, what its referent becomes, and the resources the file only
    mentions appended under **`LINKED_SECTION_TITLE`** at **`linkedKey`**.
  - **`UnlinkedMention`** — `of`: on a placed file, every **`MissingSubject`**
    and every mention that **`NamesNobodyOnDevice`**.
  - **`IdentityMap`** — the `ReadonlyMap<key, LinkChoice>` itself (`Type`),
    **`apply`** (plan, then place) and **`unlinkedMentions`**.
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
(it builds and decodes the resource) — but still no client, no other resource
schemas, and no `persistResources`: the write sink stays at the shell
(`fhir-r4/clients`' `persistBatchBundle`). It deliberately does **not** depend
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
  exclusions and edits; what a mention lands on lives in the `IdentityMap`,
  held beside the selections, and `IdentityMap.apply` runs before the server
  diff, the preview and the confirm, so all three see the resources that get
  written. `apply` is pure and idempotent and keeps the file's sections and
  keys. A referent's mentions are redirected to its destination: a decoded
  resource linked to a stored one is replaced by it **under the same review
  key**, the stored resource assuming the referent's identifiers and its own
  derived one and keeping its demographics byte for byte; every mention of the
  identity, a literal `Type/<source id>` or an identifier-only one, is
  redirected through `ResourceReferences.map`, keeping its `display` and
  `identifier`; a resource the file only mentions is appended under a final
  **"Linked"** section so the review shows the identifier it assumed; an own
  resource is written as decoded plus its derived identifier and those of the
  referents linked to it. A referent only mentions name may be `New` only
  when its identity stands for something provisional (`Provisional.forIdentity`:
  a provider's printed name, as a `Practitioner` at `localResourceId(system,
  'Practitioner', name)`, so one name from two sources is one record); its
  default stays `DontLink`. `SameAs` follows to the end; a choice a referent's
  kind does not allow, a referent of another type, or one the file does not
  hold reads as the kind's default, own resource or unlinked; a cycle reads as
  `New` for the referent resolved. `unlinkedMentions` lists, on the placed
  file, every missing `subject`, every mention that is an absolute URL, and
  every identity left identifier-only; a `display`-only provider is not one
  the map could link, so it is not listed.
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
