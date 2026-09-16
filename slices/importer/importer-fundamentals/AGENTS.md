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

- `src/file-importer-descriptor.ts` — **`FileImporterDescriptor<TSettings,
TParsed>`**, "a file-format importer" as one value a closed registry lists:
  `format` (the registry key), `display`, `detect` (cheap syntactic
  identification; **`identify`** finds the first claiming descriptor),
  `defaultSettings`, `decode(files: readonly PickedFile[], settings) →
Effect<readonly DecodeOutcome<TParsed>[]>` (requires nothing and **never
  fails** — a preview can never reach a write client, and one malformed file
  never sinks a batch), and — the **server-read seam** the shell reads
  uploaded source files back through — `sourceFileCategoryToken` (the
  `system|code` search token, promoted from the format's `/source-file`
  codec), `isSourceFile` (whether a decoded `DocumentReference` is a source
  file of _this_ format, disjoint across formats),
  `sourceFileFromDocumentReference` (the bytes-and-name reader a preview or a
  pick calls to re-hydrate one), and `sourceFileContentType` (drives the
  preview modal's renderer choice: PDF via `<iframe>`, JSON via `<pre>`).
  There is **no** `buildSourceFile` field: the format mints its own source
  file inside `decode`.
  One **`DecodeOutcome<TParsed>`** comes back per _unit_ the format decides
  on — a **`DecodedUnit`** (`_tag: 'read'`, a format-chosen `title`, the
  `files` it was decoded from, and a `DecodedFile`) or an
  **`UnreadableUnit`** (`_tag: 'unreadable'`, the same `title` and `files`,
  plus the malformed-input `ParseError`). A **`DecodedFile<TParsed>`** is
  titled **`LabeledSection`**s of **`LabeledResource`**s (stable `key`,
  one-line `title`, the parsed `resource`) plus file-level diagnostic note
  strings for what did not become a resource. **`sectionResources`** flattens
  the sections in order — the list the review transitions and the confirm
  fold over. **`SettingsPickerProps<TSettings>`** (the `{ settings, onChange }`
  contract every format's settings picker renders against) also lives here,
  below every format's React package. Settings are pre-decode input: a change
  re-decodes the unit, so resource keys must be stable across settings
  changes where the underlying resource is unchanged.
- `src/staged-import.ts` — the **`StagedImport`** namespace, the pure per-resource
  selection model. A `Selection<TParsed>` is two axes: `excludedResources`
  (per-resource opt-outs, keyed by `LabeledResource.key`) and
  `resourceOverrides` (per-resource inline edits, same keying — the
  reviewer's edited resource replaces the decoded original at confirm).
  `initial` / `toggleResource` / `setResourcesIncluded` (the batch form of
  `toggleResource`, so the shell can opt a whole section in or out at once) /
  `edit` / `revert` are the transitions;
  `isResourceIncluded` / `isResourceEdited` / `editedResource` the reads;
  `chosenResources` folds a flat labeled list through the exclusions and
  edit overrides into the confirm's write set — no re-parse at confirm, the
  reviewed (or edited) objects are what gets written; `includedCount` /
  `excludedCount` drive the shell's tallies. Orphaned selection entries
  (keys a re-decode no longer produces) are inert — sets and maps of keys,
  nothing dangling.
- `src/persist-failure.ts` — **`PersistFailure`**, the structural echo of a
  write sink's own failure record (`{ failed: { label, id }, cause }`). Declared
  here — this package sits below the concrete sinks and cannot name them — and
  checked **structurally** at each binding's seam, mirroring how
  `collector-fundamentals` declares its `PersistFailure` against `fhir-r4`'s
  `ResourceWriteFailure`.
- `src/source-file-codec.ts` — **`sourceFileCodec(config)`**, the one
  definition of how any uploaded source file is stored as a FHIR R4
  `DocumentReference` (one attachment carrying the bytes verbatim, `subject`
  deliberately absent unless a format passes one). The HAR and LifeLabs codecs
  were identical bar their coding, content type, description text, and (HAR
  only) a `securityLabel`, so the shape lives here and each binding passes
  those in as **data** — `har-importer-core/source-file`,
  `lifelabs-pdf-importer-core/source-file`, and
  `dicom-importer-core/source-file` are thin config + re-export shims. The
  returned **`SourceFileCodec`** carries the `SourceFile` schema (+
  `SourceFileId`), both directions (`SourceFileFromDocumentReference` /
  `SourceFileFromFhirJson` and their `encode`/`decode`), the pure `toWire`
  builder, `isSourceFile`, the `categoryToken`, and **`buildSourceFile`** —
  the mint a format's `decode` calls per `local` pick: it derives a
  **deterministic** id from the bytes' SHA-256 and the file name via
  `fhir-r4/identity`'s `localResourceId` (so re-importing the same file
  upserts rather than duplicating), reads the clock for the upload instant,
  and encodes. The mint lives here, not per binding, because the id needs the
  digest and the shared derivation, both of which this package owns. A
  binding still owns its own coding constants (a HAR binding passes
  `web-trace-core`'s), so this module names no format and imports no format
  slice. The shared builder is pinned by `source-file-codec.test.ts`, so a
  format's `/source-file` test asserts only its own config.
- `src/source-file-review.ts` — the generic pieces a format composes **inside
  its own `decode`** to own its source file: **`sourceFileFor`** (mint through
  the codec for a `local` pick, resolve the existing `DocumentReference/<id>`
  for a `server` one), **`withSourceSections`** (prepend each minted resource
  as its own `SOURCE_SECTION_TITLE` — "Source file" — section),
  **`withMetaSource`** / **`stampMetaSource`** (write `meta.source` onto one
  resource, or onto every resource in every section), **`sourceFileKey`** (the
  stable review key, `source-file/<fileName>`), and **`perFileDecode(codec,
decodeOne, { subjectFor? })`** — which strings them together into the
  descriptor's batch `decode` for a single-file format, one unit per file,
  folding a `ParseError` into that file's own `unreadable` unit. A group
  format calls the pieces itself. `decodeOne(file, settings, source)` receives
  the resolved **`SourceFileRef`**, so a format whose resources name the
  stored file (DICOM's `ImagingStudy` `gridfsFileId`) reads the id there
  rather than recomputing it.
- `src/picked-file.ts` — **`PickedFile`** (`{ fileName, bytes, source }`), the
  one value every picker source converges on and every `decode` receives, plus
  its **`PickedFileSource`** (`local` / `server` with a `reference`),
  `LOCAL_SOURCE`, `serverSource`, and the one spelling of a source file's
  reference in both directions — **`sourceFileReference`** and
  **`sourceFileIdOf`**. Bytes rather than text so the picker stays
  format-blind; the provenance rides along because minting or not minting a
  source file is the decode's decision.
- `src/sha256.ts` — **`sha256Base64`** (+ `DigestUnavailable`), the base64
  SHA-256 the source file attachment's `hash` carries, over Web Crypto. A verbatim
  copy of `web-trace-core`'s helper (the standard digest, no project-specific
  behaviour), kept here so the codec above needs no `web-trace-core` dependency
  — a copy, because moving it would invert the importer → web-trace direction.

## Layering

Depends on `effect` (and `kitchen-sink` in tests), plus `fhir-r4` for the
`DocumentReference` schema and `DocumentReferenceType`, `fhir-r4/data-types`
for `Meta` (the slot `withMetaSource` writes into), `fhir-r4/identity` for the
shared id derivation, and `fhir`'s wire types. Hosting the shared
`sourceFileCodec` is what widened `fhir-r4` from a type-only import to the
`DocumentReference` runtime schema (the codec builds and decodes the resource)
— but still no client, no other resource schemas, and no `persistResources`:
the write sink stays at the shell (`fhir-r4/clients`' `persistBatchBundle`) and
the per-format extracted resource type is still `TParsed`. It deliberately does
**not** depend on `web-trace-core`: the digest helper (`sha256.ts`) and
`withMetaSource` are both verbatim copies of web-trace's, for the same reason —
standard, project-neutral helpers, and moving them would invert the
importer → web-trace direction. A HAR binding passes web-trace's coding
constants in as data. Names no source-file _format_ (each binding supplies
`decode` and its coding), no HTTP vocabulary (the HAR binding's recognition
machinery lives in `har-importer-core`), and no UI framework. Never imports a
`*-importer-core`, an `importer-core`, a `*-importer-react`,
`slices/collector`, or `slices/http-extraction`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes `StagedImport.chosenResources` —
  the same objects, filtered by the exclusions, with edits substituted — with
  no re-parse. This split is the whole point; do not collapse it.
- **Sections and notes are the whole review surface.** A format with routing
  decisions (HAR's kind toggles) expresses them as _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **`decode` never fails.** Malformed input is an `unreadable` unit, not an
  error channel: a format folds the `ParseError` into the unit it belongs to,
  so one bad file in a batch leaves the rest reviewable and nothing above this
  package needs a `catchAll`.
- **The source file is the format's, minted inside `decode`.** What a source
  file is, which resources point at it, and what happens to those links are
  each format's decisions, expressed through `source-file-review.ts`'s
  helpers. The shell has no source-file knowledge at all — it reviews the
  minted row like any other resource. Do not put a `buildSourceFile` back on
  the descriptor or a mint back in the shell.
- **Selection keys by `LabeledResource.key`.** Selection state must be
  serializable and survive a settings re-decode, so both axes hold string
  keys; a key that disappears simply stops applying.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that implements this contract.
- [importer-core AGENTS.md](../importer-core/AGENTS.md) — the closed registry
  and the batch machinery built on this contract.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  drives the `StagedImport` transitions over those units.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
