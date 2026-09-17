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

- `src/file-importer.ts` — **`FileImporter<TFormat, TSettings>`**, "a
  file-format importer" as one first-class value a closed registry lists, and
  **`fileImporter(config)`**, which builds one from a binding's config
  (`format`, `coding`, `contentType`, `display`, `detect`, `defaultSettings`,
  `decodeOne: SourceFile.DecodeOne<TSettings>`, optional `securityLabel` /
  `subjectFor`). A `FileImporter` is a **plain record, not a class instance**:
  an adapter layer extends one by spreading it (which is how
  `importer-react`'s registry attaches each format's `SettingsPicker`), and a
  spread is only total when there is no prototype to lose. The factory derives,
  from the coding and content type alone: the per-format `SourceFile` schema
  and its `SourceFileFromDocumentReference` transform, `isSourceFile`,
  `sourceFileFromDocumentReference` / `sourceFileToDocumentReference`,
  `categoryToken`, the deterministic mint (`mintSourceFile` decides the id — a
  SHA-256 of the bytes plus the file name via `fhir-r4/identity`'s
  `localResourceId`, so re-importing the same file upserts rather than
  duplicating — and defers the `DocumentReference`; `buildSourceFile` does
  both at once), and `decode` itself. That last one, `buildPerFileDecode`, is
  where the per-file contract becomes the batch one: for each claimed file it
  resolves the source (mint for a `local` pick, read the reference back for a
  `server` one), runs the binding's `decodeOne` with the resolved id,
  **namespaces the decode's review keys** by the file's slot
  (`FormatDecode.keyPrefix`), stamps every resource's `meta.source` via
  `MetaSource.stampDecoded`, finishes the mint under the subject `subjectFor`
  reads off the decode, prepends it as the file's "Source file" section, and
  folds a `ParseError` into that file's own `unreadableFiles` entry. No format
  names another format: a binding supplies only its own coding constants and
  `decodeOne`. Also holds `Coding`, `Subject`, `MintedSourceFile`,
  `DocumentReferenceType`, `FileImporterConfig`,
  `SettingsPickerProps<TSettings>` (the `{ settings, onChange }` contract
  every format's settings picker renders against, below every format's React
  package), **`Detectable`**, and **`identify`** (the first candidate whose
  `detect` claims a pick).
- `src/format-decode.ts` — the **`FormatDecode`** namespace: **`Result<K>`**
  (one format's whole decode — its id, title, files, merged `DecodedFile` and
  **`UnreadableFile`** rows), **`emptyResult`** for a format that claimed
  nothing, and the identity derivations every id and review key is built from.
  **`fileSlot(index, file)`** is the primitive: _position first_, then name, so
  two picks of the same name (two `report.pdf`s out of two folders) stay
  distinct. **`makeId`** names a whole batch, **`makeFileId`** one file within
  it, and **`keyPrefix`** is the namespace every review key decoded out of one
  file carries — which is what keeps a fixed key like DICOM's `patient`, or
  HAR's per-archive `har-entry-<index>`, from colliding across the files one
  format claimed.
- `src/source-file.ts` — the **`SourceFile`** namespace every binding and the
  shell import: **`Type`** (a decoded source file's `id` / `fileName` /
  `uploadedAt` / `bytes`), **`Ref`** (the resolved per-decode id a
  `DecodeOne` receives), **`Reference`** (the typed
  `` `DocumentReference/${string}` `` a stamped resource's `meta.source`
  points at, plus `makeReference` / `idFromReference` / `isReference`),
  **`DecodeOne<TSettings>`** (one format's per-file decode signature —
  `(file, settings, source: Ref) => Effect<DecodedFile.DecodedFile, ParseError>`),
  **`SubjectFor`** (how a format names the subject its minted source file is
  filed under — called with the file's _decode_, so a format reads the subject
  off the resources it already extracted rather than parsing the file twice),
  **`PerFileDecodeOptions`**, and **`SECTION_TITLE`** / **`key`**
  (the review section title and the stable per-file row key a minted source
  file is reviewed under). Depends only on `decoded-file.ts` and
  `picked-file.ts` (types only, so no runtime cycle even though
  `picked-file.ts` depends back on this module for `Reference` /
  `makeReference`).
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
- `src/picked-file.ts` — **`PickedFile`** (`{ fileName, bytes, source }`), the
  one value every picker source converges on and every `decode` receives, and
  **`Source`** (`local` / `server` with a `SourceFile.Reference`), the file's
  provenance. The module is consumed as the `PickedFileSource` namespace, so
  the type inside it is `Source` rather than `PickedFileSource` — one name
  meaning two things at the same import site is what that avoids. Bytes rather
  than text so the picker stays format-blind; the provenance rides along
  because minting or not minting a source file is the decode's decision.
- `src/sha256.ts` — **`sha256Base64`** (+ `DigestUnavailable`), the base64
  SHA-256 the source file attachment's `hash` carries, over Web Crypto. A verbatim
  copy of `web-trace-core`'s helper (the standard digest, no project-specific
  behaviour), kept here so the codec above needs no `web-trace-core` dependency
  — a copy, because moving it would invert the importer → web-trace direction.

## Layering

Depends on `effect` (and `kitchen-sink` in tests), plus `fhir-r4` for the
`DocumentReference` schema and `DocumentReferenceType`, `fhir-r4/resources` for
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
- **`decode` never fails.** Malformed input is an `unreadableFiles` entry, not
  an error channel: `buildPerFileDecode` folds the `ParseError` into the file
  it belongs to, so one bad file in a batch leaves the rest reviewable and
  nothing above this package needs a `catchAll`.
- **The source file is the format's, minted inside `decode`.** What a source
  file is, which resources point at it, and what happens to those links are
  each format's decisions, expressed through `file-importer.ts`'s internal
  helpers over the `source-file.ts` vocabulary. The shell has no source-file
  knowledge at all — it reviews the minted row like any other resource. Do not
  put the mint back in the shell.
- **Review keys are namespaced per file, here and nowhere else.** A
  `decodeOne` keys within _one_ file, because that is all it can see; the
  batch merges every claimed file's sections into one format-wide review,
  while the selection, the server-diff verdicts and the write plan are all
  keyed by `(format, key)`. `buildPerFileDecode` prefixes each file's keys
  with its slot, which is what makes a fixed key safe. Do not push that
  obligation down into the bindings — a `decodeOne` that tries to be unique
  across a batch cannot be, since it is not given the batch.
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
