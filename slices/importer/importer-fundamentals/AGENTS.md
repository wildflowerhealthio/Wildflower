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
  file-format importer" as one first-class value a closed registry lists:
  `format`, `display`, `detect`, `defaultSettings`, the batch `decode`, and
  `sourceFileFormat` (the format's `SourceFile.FormatValue` — its `coding` /
  `contentType` / `securityLabel` / `descriptionPrefix`, the last spelled by
  the binding, conventionally `` `${display.title}: ` ``). **An interface and
  nothing else**: a binding writes the value as a **literal**, because every
  field is either a constant it states or a function it already has, and
  `decode` comes from `DecodeFunction.make`. A `FileImporter` is a **plain
  record, not a class instance**: an adapter layer extends one by spreading it
  (which is how `importer-react`'s registry attaches each format's
  `SettingsPicker`), and a spread is only total when there is no prototype to
  lose. The **write direction is not a member**: minting and encoding a source
  file is something only the batch `decode` does, through `SourceFile`'s own
  schemas. What a reader of the server's source-file list needs —
  `SourceFile.categoryToken`, `SourceFile.isSourceFile`,
  `SourceFile.FromDocumentReference` — it gets by applying those to the
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
  `fileSlot(index, file)` is the primitive the three below share — _position
  first_, then name, so two picks of the same name (two `report.pdf`s out of two
  folders) stay distinct; it is module-private, since nothing outside composes
  with a slot. **`makeId`** names a whole batch, **`makeFileId`** one file within
  it, and **`keyPrefix`** is the namespace every review key decoded out of one
  file carries — which is what keeps a fixed key like DICOM's `patient`, or
  HAR's per-archive `har-entry-<index>`, from colliding across the files one
  format claimed.
- `src/source-file.ts` — the **`SourceFile`** namespace: the source-file
  vocabulary _and_ the codec that stores one. **`Type`** (a source file's `id` /
  `fileName` / `uploadedAt` / `bytes`, plus the links a stored archive carries:
  a `subject` `Option` and the `related` list), **`Subject`**, **`Coding`**,
  **`Reference`** (the typed `` `DocumentReference/${string}` `` a stamped
  resource's `meta.source` points at, plus `makeReference` /
  `idFromReference`) — the **single currency for "which source file"**, which a
  `decodeFileSet` receives, which a `server` pick already carries, and which
  `idFromReference` unwraps only where a format needs the bare id (DICOM's
  `gridfsFileId`).
  The codec is three schemas and two projections, all over one format's
  **`FormatValue`**, which reaches them as the **`Format`** `Context.Tag`:
  **`FromDocumentReference`** (the codec proper — its read leg accepts only an
  archive of this format carrying attachment data and then projects it, so a
  rejected archive reports through the schema's own issue; its write leg hashes
  the bytes into the attachment `hash` and writes the value's own `subject` and
  `related`), **`FromNamedBytes`** (the deterministic mint — the id a SHA-256 of
  the bytes plus the file name through `fhir-r4/identity`'s `localResourceId`,
  so re-importing the same file upserts rather than duplicating and no two
  formats collide), and **`NamedBytesFromDocumentReference`** (the two composed,
  which is the single decode the preview dialog reads a stored archive's name
  and bytes with). **`categoryToken`** and **`isSourceFile`** are plain
  projections of the constants — not codec work, so not schemas.
  A validated `DocumentReference` is **not** named here as a type of its own: a
  module that needs it imports `DocumentReference` from `fhir-r4/resources` and
  writes `DocumentReference.Type`, so the resource schema stays the one place
  its decoded shape is spelled. Note `ArchiveSchema` is a `Schema.declare` over
  that type rather than `Schema.typeSchema(DocumentReference.Schema)`, whose
  encode walks the struct and turns a `null` optional into `undefined`.
- `src/decode-function.ts` — the **`DecodeFunction`** namespace: the batch
  decode's signature **and the one constructor that builds it**. **`Type`** is
  the signature a `FileImporter` exposes (files and settings in, one
  `FormatDecode.Result` out, never failing, requiring nothing).
  **`make(config)`** takes a **`Config`**: the `format`, the `sourceFileFormat`,
  a `decodeFileSet`, and — for a format whose files are read together — a
  `partition` and an `archiveLinks`. **`Member`** is one claimed file with its
  index; **`Partition`** is what a `partition` yields (the non-empty
  `fileSets` decoded together, each ordered so its first member is the set's
  representative, plus the `unreadable` picks it could not place);
  **`ArchiveLinks`** is what an archive points at, read off the set's decode.
  Left out, `partition` is "every file alone, in pick order" — which is what a
  format whose files stand alone (HAR, LifeLabs PDF) states by saying nothing.
  Per set, concurrently across sets, `make` resolves each pick to a
  `SourceFile.Reference` (minting through `SourceFile.FromNamedBytes` for a
  `local` pick, passing a `server` pick's existing reference through verbatim),
  runs `decodeFileSet`, **namespaces the decode's review keys** by the
  representative's slot (`FormatDecode.keyPrefix`), stamps every resource's
  `meta.source` with the representative's reference
  (`MetaSource.stampDecoded`), encodes each minted archive under
  `archiveLinks(decoded)` and prepends them as the set's **"Source file"** /
  **"Source files"** section, and folds a `ParseError` into one
  `unreadableFiles` row per pick of the failing set. It provides the
  `SourceFile.Format` service from `config.sourceFileFormat` internally, so
  nothing it returns carries a requirement.

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
wire types. Hosting the source-file schemas is what widened
`fhir-r4` from a type-only import to the `DocumentReference` runtime schema
(it builds and decodes the resource) — but still no client, no other resource
schemas, and no `persistResources`: the write sink stays at the shell
(`fhir-r4/clients`' `persistBatchBundle`). It deliberately does **not** depend
on `web-trace-core`: the digest helper (`sha256.ts`) and `meta-source.ts` are
both verbatim-in-spirit copies of web-trace's, for the same reason — standard,
project-neutral helpers, and moving them would invert the importer →
web-trace direction. A HAR binding passes web-trace's coding constants in as
data. Names no source-file _format_ (each binding supplies its `decodeFileSet` and
its coding), no HTTP vocabulary (the HAR binding's recognition machinery lives in
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
- **`DecodeFunction.make` provides `SourceFile.Format`; the shell provides it
  at its two reads; no other production code does.** The schemas are
  parameterized by that tag, the constructor discharges it once from the
  `sourceFileFormat` it was handed, and `importer-react`'s two reads of a
  stored archive (`fetchSourceFile`, `fetchSourceFileContents`) provide it from
  the registry entry's own `sourceFileFormat`. See "Bake an internal context
  requirement to reshape the public type" in the
  [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md).
  A new source-file operation belongs in `source-file.ts` requiring the tag,
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
- **The source file is the format's, minted inside `decode`.** What a source
  file is, which resources point at it, and what happens to those links are
  each format's decisions, expressed through `decode-function.ts`'s constructor
  over the `source-file.ts` vocabulary and schemas. The shell has no source-file
  knowledge at all — it reviews the minted row like any other resource. Do not
  put the mint back in the shell.
- **Review keys are namespaced per file set, here and nowhere else.** A
  `decodeFileSet` keys within _one_ set, because that is all it can see; the
  batch merges every claimed file's sections into one format-wide review,
  while the selection, the server-diff verdicts and the write plan are all
  keyed by `(format, key)`. `DecodeFunction.make` prefixes each set's keys with
  its representative's slot (`FormatDecode.keyPrefix`), which is what makes a
  fixed key safe. Do not push that obligation down into a `decodeFileSet` —
  one that tries to be unique across a batch cannot be, since it is not given
  the batch.
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
