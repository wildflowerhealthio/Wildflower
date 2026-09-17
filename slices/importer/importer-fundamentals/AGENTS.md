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

- `src/file-importer-descriptor.ts` — **`FileImporter<TFormat, TSettings>`**,
  "a file-format importer" as one first-class value a closed registry lists.
  Constructed from a binding's config (`format`, `coding`, `contentType`,
  `display`, `detect`, `defaultSettings`, `decodeOne: SourceFile.DecodeOne<TSettings>`,
  optional `securityLabel` / `subjectFor`) — or from `{ from: otherImporter }`
  to derive a variant. The constructor builds, from the coding and content
  type alone: the per-format `SourceFile` schema and its
  `SourceFileFromDocumentReference` transform, `isSourceFile`,
  `sourceFileFromDocumentReference` / `sourceFileToDocumentReference`,
  `categoryToken`, `buildSourceFile` (the deterministic mint — a SHA-256 of
  the bytes plus the file name via `fhir-r4/identity`'s `localResourceId`, so
  re-importing the same file upserts rather than duplicating), and `decode`
  itself (`buildPerFileDecode`: resolve each file's source through
  `resolveSourceFile` — mint for a `local` pick, read back the reference for a
  `server` one — run the binding's `decodeOne`, stamp every resource's
  `meta.source` via `MetaSource.stampDecoded`, and prepend the source-file row
  via `withSourceSections`). No format names another format: a binding
  supplies only its own coding constants and `decodeOne`. Also holds
  `Coding`, `DocumentReferenceType`, `SourceFileEncoded`,
  `SettingsPickerProps<TSettings>` (the `{ settings, onChange }` contract
  every format's settings picker renders against, below every format's React
  package), and **`identify`** (the first registered importer whose `detect`
  claims a pick).
- `src/source-file.ts` — the **`SourceFile`** namespace every binding and the
  shell import: **`Type`** (a decoded source file's `id` / `fileName` /
  `uploadedAt` / `bytes`), **`Ref`** (the resolved per-decode id a
  `DecodeOne` receives), **`Reference`** (the typed
  `` `DocumentReference/${string}` `` a stamped resource's `meta.source`
  points at, plus `makeReference` / `idFromReference` / `isReference`),
  **`DecodeOne<TSettings>`** (one format's per-file decode signature —
  `(file, settings, source: Ref) => Effect<DecodedFile.DecodedFile, ParseError>`),
  **`PerFileDecodeOptions`** (`subjectFor`), and **`SECTION_TITLE`** / **`key`**
  (the review section title and the stable per-file row key a minted source
  file is reviewed under). Depends only on `decoded-file.ts` and
  `picked-file.ts` (types only, so no runtime cycle even though
  `picked-file.ts` depends back on this module for `Reference` /
  `makeReference`).
- `src/staged-import.ts` — the **`StagedImport`** namespace, the pure per-resource
  selection model. A `Selection` is two axes: `excludedResources`
  (per-resource opt-outs, keyed by `LabeledResource.key`) and
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
  its **`PickedFileSource`** (`local` / `server` with a `SourceFile.Reference`)
  the file's provenance. Bytes rather than text so the picker stays
  format-blind; the provenance rides along because minting or not minting a
  source file is the decode's decision.
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
- **`decode` never fails.** Malformed input is an `unreadable` unit, not an
  error channel: a format folds the `ParseError` into the unit it belongs to,
  so one bad file in a batch leaves the rest reviewable and nothing above this
  package needs a `catchAll`.
- **The source file is the format's, minted inside `decode`.** What a source
  file is, which resources point at it, and what happens to those links are
  each format's decisions, expressed through `file-importer-descriptor.ts`'s
  internal helpers over the `source-file.ts` vocabulary. The shell has no
  source-file knowledge at all — it reviews the minted row like any other
  resource. Do not put a `buildSourceFile` back on the descriptor or a mint
  back in the shell.
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
