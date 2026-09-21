# AGENTS.md — slices/importer/importer-fundamentals

The **resource-agnostic, format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-resource
staged-import model (what a decoded-but-unwritten import consists of), and the
structural failure record the sinks report against. It is to the
importer slice what `collector-fundamentals` is to the collector slice — the
layer a concrete binding (`har-importer-core`, `lifelabs-pdf-importer-core`)
sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell drives.

## Shape

- `src/file-importer.ts` — **`FileImporter.Type<TSettings, TFormat>`**, "a
  file-format importer" as one first-class value a closed registry lists, and
  **`FileImporter.make(config)`**, which builds one from a binding's
  `FileImporterConfig` (`format`, `sourceFileFormat: SourceFileCodec.Format`,
  `decode`, `display`, `detect`, `defaultSettings`). The source-file constants
  arrive as **one `SourceFileCodec.Format`** — the value the codec is parameterized
  by (`coding` / `contentType` / `securityLabel` / `descriptionPrefix`, the
  last spelled by the binding, conventionally `` `${display.title}: ` ``,
  rather than derived here) — and the decode arrives as a **still-unbound
  `DecodeFunction.WithContext<…, SourceFileCodec.FormatContext>`**, typically from
  `PerFileDecodeFunction.make`.
  A `FileImporter` is a **plain record, not a class instance**:
  an adapter layer extends one by spreading it (which is how
  `importer-react`'s registry attaches each format's `SettingsPicker`), and a
  spread is only total when there is no prototype to lose. **The factory is the
  binder**: it provides the config's `sourceFileFormat` as the
  `SourceFileCodec.FormatContext` at the boundary, so every member it returns — the
  `SourceFileFromDocumentReference` transform behind
  `sourceFileFromDocumentReference`, and the batch `decode` it binds — requires
  nothing. That is also why `sourceFileFormat` is spelled **once**: the decode
  arrives needing the context and gets the same constants `categoryToken` and
  `isSourceFile` are built from, so the two cannot disagree.
  The **write direction is not a member**: minting and encoding a
  source file is something only the batch `decode` does, through
  `source-file-codec.ts`'s own operations. What the factory carries as data instead is
  `sourceFileFormat`, the built `SourceFileCodec.Format` — which is how a binding's
  test drives the codec under that format's real config rather than restating
  it. What it owns itself is the per-format wrapping: the schema transform
  and its annotations, `isSourceFile`, and `categoryToken`; the codec underneath
  is `source-file-codec.ts`'s. No format
  names another format: a binding supplies only its own coding constants and
  `decodeOne`.
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
  `fileSlot(index, file)` is the primitive the three below share — _position
  first_, then name, so two picks of the same name (two `report.pdf`s out of two
  folders) stay distinct; it is module-private, since nothing outside composes
  with a slot. **`makeId`** names a whole batch, **`makeFileId`** one file within
  it, and **`keyPrefix`** is the namespace every review key decoded out of one
  file carries — which is what keeps a fixed key like DICOM's `patient`, or
  HAR's per-archive `har-entry-<index>`, from colliding across the files one
  format claimed.
- `src/source-file.ts` — the **`SourceFile`** namespace: the source-file
  _vocabulary_, context-free and format-agnostic. **`Type`** (a decoded source
  file's `id` / `fileName` / `uploadedAt` / `bytes`), **`Coding`** (the
  `system`/`code` axis one format tags on), **`Reference`** (the typed
  `` `DocumentReference/${string}` `` a stamped resource's `meta.source`
  points at, plus `makeReference` / `idFromReference`) — the **single currency
  for "which source file"**, which a `decodeOne` receives, which a `server` pick
  already carries, and which `idFromReference` unwraps only where a format needs
  the bare id (DICOM's `gridfsFileId`). A validated `DocumentReference` is
  **not** named here: a module that needs that type imports `DocumentReference`
  from `fhir-r4/resources` and writes `DocumentReference.Type`, so the resource
  schema stays the one place its decoded shape is spelled.
  It imports nothing from this package and does nothing at runtime beyond
  concatenating or slicing a string, which is what lets `picked-file-source.ts`
  and `meta-source.ts` name a `Reference` without pulling the codec in behind
  it. Splitting it from the codec is also what removed the module cycle those
  two used to sit inside.
- `src/source-file-codec.ts` — the **`SourceFileCodec`** namespace: the codec
  turning a `SourceFile.Type` into the `DocumentReference` it is stored as and
  back, written once rather than per format. **`tryFromNamedBytes`** (the
  deterministic mint — the id a SHA-256 of the bytes plus the file name through
  `fhir-r4/identity`'s `localResourceId`, so re-importing the same file upserts
  rather than duplicating and no two formats collide), **`encode`** (source file
  → its `DocumentReference`, under a **`Filing`**: the **`Subject`** whose
  record it belongs in, and the `related` resources it is a source of, which
  the resource carries as `context.related`),
  **`mintResource`** (the mint then the encode, in one step — named for its
  _result_, since unlike `tryFromNamedBytes` it yields the stored resource
  rather than a `SourceFile.Type`), **`decode`** (a stored resource → back, or a
  failure naming the resource and the reason), the
  **`FromDocumentReferenceSchema`** transform, and the two format predicates
  **`inFormatsCategory`** / **`categoryToken`**. `encode` and `decode` are the
  public mirror pair; the private `hashAndBuild` under `encode` is the half that
  takes an `ast` to blame, so a digest failure is reported against the schema its
  caller was working in. All are parameterized by **`FormatContext`**, the
  `Context.Tag` carrying one format's **`Format`** — its `coding` /
  `contentType` / `securityLabel` / `descriptionPrefix`. Depends on
  `source-file.ts` for the vocabulary and on `picked-file.ts` for
  `NamedBytes` (types only); `source-file.ts` knows nothing of it.
- `src/decode-function.ts` — the **`DecodeFunction`** namespace: the batch
  decode's signature and nothing else. **`WithContext<TSettings, TFormat, R>`**
  spells the requirement still outstanding, and **`Type`** is the bound end
  (`R = never`) a `FileImporter` exposes. **Types only, no constructor** — how a
  format gets from its files to a `FormatDecode.Result` is the format's own
  business, and keeping the contract free of any one way of meeting it is what
  makes "this is one kind of decode function" a statement the file layout can
  make rather than a comment.
- `src/per-file-decode-function.ts` — the **`PerFileDecodeFunction`** namespace:
  **one constructor** of that contract, for a format whose files decode
  independently. **`make(config)`** takes a **`Config`** (the binding's
  `format`, `decodeOne`, and optional `subjectFor`, whose type
  **`FileSubjectForPair`** this module also owns — how a format names the
  subject its minted source file is filed under, called with the file's _decode_
  so a format reads the subject off the resources it already extracted rather
  than parsing the file twice). _Per-file_ is a real assumption, and it is what
  earns everything the constructor does: `decodeOne` is handed one file and
  cannot see the others, the per-file results **sum** into the batch's, and so
  the files can run concurrently and one rejection cannot spoil the rest. A
  format whose files must be read together (a multi-part archive, a manifest
  naming its siblings) is not per-file and needs a **sibling module beside this
  one**, not a widened version of it — `dicom-importer-core`'s study decode is
  the first, and it lives in that binding rather than here because what is
  custom about it (a study, its series, its instances) is DICOM's alone.
  For each claimed file `make` resolves the source to a `SourceFile.Reference`
  (minting for a `local` pick, passing a `server` pick's existing reference
  through verbatim), runs the binding's `decodeOne` with it, **namespaces the
  decode's review keys** by the file's slot (`FormatDecode.keyPrefix`), stamps
  every resource's `meta.source` via `MetaSource.stampDecoded`, finishes the mint
  under the subject `subjectFor` reads off the decode, prepends it as the file's
  "Source file" section, and folds a `ParseError` into that file's own
  `unreadableFiles` entry. That row's shape is this module's, and it takes no
  `SourceFileCodec.Format` of its own, because a second copy of a format's
  constants here could disagree with the one the importer reads `categoryToken`
  and `isSourceFile` out of.
- `src/source-file-mint.ts` — the **`SourceFileMint`** namespace: the minting
  half **every** decode function shares, whatever its unit. **`resolve(file)`**
  yields a pick's `SourceFile.Reference` — a `server` pick's existing one, or a
  freshly minted one plus the deferred **`encode(filing)`** that builds the
  archive _after_ the decode has run, since the `SourceFileCodec.Filing` it is
  stored under is read off the decode's own resources.
  **`prependSection(decoded, rows)`** puts the minted archives ahead of the
  sections read out of them ("Source file", or "Source files" for a unit of
  several), and **`key(fileName)`** is the row key. Split out of
  `per-file-decode-function.ts` when a second constructor appeared: none of it
  is per-file or per-group. Like its caller it goes through the codec
  _unbound_, so the decode a constructor builds still carries the
  `FormatContext` requirement for `FileImporter.make` to bind.
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
- `src/picked-file.ts` — **`PickedFile.Type`** (`{ fileName, bytes, source }`),
  the one value every picker source converges on and every `decode` receives.
  Bytes rather than text so the picker stays format-blind; the provenance rides
  along because minting or not minting a source file is the decode's decision.
  Also **`NamedBytes`** (`{ fileName, bytes }`), the provenance-free half
  `Type` extends — one name for the shape the source-file mint, the read of a
  stored source file's contents, and `FormatDetector.claiming` all take, instead
  of three structural copies of it.
- `src/picked-file-source.ts` — **`Source`** (`local` / `server` with a
  `SourceFile.Reference`), a pick's provenance, re-exported by `picked-file.ts`
  and consumed as `PickedFile.Source`. Its own module because it and the picked
  file both call their main type `Type` — the convention every namespace here
  follows — and one module cannot hold two.
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
to abstract over), `fhir-r4/data-types` for `Meta` (the slot `MetaSource.stamp`
writes into), `fhir-r4/identity` for the shared id derivation, and `fhir`'s
wire types. Hosting `FileImporter`'s source-file schema is what widened
`fhir-r4` from a type-only import to the `DocumentReference` runtime schema
(it builds and decodes the resource) — but still no client, no other resource
schemas, and no `persistResources`: the write sink stays at the shell
(`fhir-r4/clients`' `persistBatchBundle`). It deliberately does **not** depend
on `web-trace-core`: the digest helper (`sha256.ts`) and `meta-source.ts` are
both verbatim-in-spirit copies of web-trace's, for the same reason — standard,
project-neutral helpers, and moving them would invert the importer →
web-trace direction. A HAR binding passes web-trace's coding constants in as
data. Names no source-file _format_ (each binding supplies `decodeOne` and its
coding), no HTTP vocabulary (the HAR binding's recognition machinery lives in
`har-importer-core`), and no UI framework. Never imports a `*-importer-core`,
an `importer-core`, a `*-importer-react`, `slices/collector`, or
`slices/http-extraction`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes `StagedImport.chosenResources` —
  the same objects, filtered by the exclusions, with edits substituted — with
  no re-parse. This split is the whole point; do not collapse it.
- **Sections and notes are the whole review surface.** A format with routing
  decisions (HAR's kind toggles) expresses them as _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **`FileImporter.make` is the only binder of `SourceFileCodec.FormatContext`.** The
  codec is parameterized by it, `PerFileDecodeFunction.make` passes the
  requirement through, and the factory discharges it once from the config it was
  handed. No `FileImporter` member carries the requirement, and no production
  code above this package provides it — only a binding's own codec test does,
  from the `sourceFileFormat` its importer carries. See "Bake an internal
  context requirement to reshape the
  public type" in the [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md).
  A new source-file operation belongs in `source-file-codec.ts` requiring the
  tag, not in the factory closing over `coding`.
  This is also what keeps **`sourceFileFormat` spelled once** per binding: a
  constructor that took its own copy could hand the decode constants that
  disagree with the ones `categoryToken` and `isSourceFile` were built from, and
  nothing would catch it.
- **`decode` never fails.** Malformed input is an `unreadableFiles` entry, not
  an error channel: a decode constructor folds the `ParseError` into the file
  it belongs to (a group format, into one row per file of the failing unit), so
  one bad file in a batch leaves the rest reviewable and nothing above this
  package needs a `catchAll`.
- **Nothing here is re-exported twice.** A symbol has one route: `index.ts`
  exposes each module as its namespace, and a flat re-export beside it would
  give the same symbol a second spelling. Only modules that are _not_
  namespaces (`sha256.ts`, `settings-picker-props.ts`) export flat.
- **The source file is the format's, minted inside `decode`.** What a source
  file is, which resources point at it, and what happens to those links are
  each format's decisions, expressed through `file-importer.ts`'s internal
  helpers over the `source-file.ts` vocabulary and the `source-file-codec.ts`
  operations. The shell has no source-file
  knowledge at all — it reviews the minted row like any other resource. Do not
  put the mint back in the shell.
- **Review keys are namespaced per file, here and nowhere else.** A
  `decodeOne` keys within _one_ file, because that is all it can see; the
  batch merges every claimed file's sections into one format-wide review,
  while the selection, the server-diff verdicts and the write plan are all
  keyed by `(format, key)`. The decode constructor prefixes each unit's keys
  with the slot of the pick that opened it (`FormatDecode.keyPrefix`), which is
  what makes a fixed key safe. Do not push that obligation down into a
  per-file `decodeOne` — one that tries to be unique across a batch cannot be,
  since it is not given the batch.
- **Selection keys by a `DecodedFile.Resource`'s `key`.** Selection state must
  be serializable and survive a settings re-decode, so both axes hold string
  keys; a key that disappears simply stops applying.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that builds on this contract.
- [importer-core AGENTS.md](../importer-core/AGENTS.md) — the closed registry
  and the batch machinery built on this contract.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  drives the `StagedImport` transitions over each format's review.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
