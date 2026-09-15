# AGENTS.md — slices/importer/importer-fundamentals

The **resource-agnostic, format-agnostic upstream** of the importer slice: the
contract every file-format binding implements, the pure per-resource review
model, and the structural failure record the sinks report against. It is to the
importer slice what `collector-fundamentals` is to the collector slice — the
layer a concrete binding (`har-importer-core`, `lifelabs-pdf-importer-core`)
sits on top of.

No DOM, no `fs`, no React: pure data and transitions the shell drives.

## Shape

- `src/file-importer-descriptor.ts` — **`FileImporterDescriptor<TSettings,
TParsed>`**, "a file-format importer" as one value a closed registry lists:
  `format` (the registry key), `display`, `accept` (the picker `accept`
  tokens — a hint to the OS dialog, never the decision, joined across every
  registered format by **`acceptFor`**), `detect` (cheap syntactic
  identification; **`identify`** finds the first claiming descriptor),
  `defaultSettings`, `decode(fileBytes, fileName, settings) → Effect<DecodedFile,
ParseError>` (requires nothing — a preview can never reach a write client;
  `fileName` lets a format recompute another seam's deterministic id from the
  same bytes+name, e.g. DICOM's `ImagingStudy` instance stamping the id of its
  own source-file `DocumentReference`),
  `sourceArchive` (**pure** — builds a local pick's bytes into a source-archive
  `DocumentReference`, minted at read time and reviewed like any resource; it
  is written in the shell's one `persistBatchBundle`, not a private upload, so
  no descriptor field takes a write client and the `R` parameter is gone), and
  — the **archive-read seam** the shell reads uploaded archives back through —
  `archiveCategoryToken` (the
  `system|code` search token, promoted from the format's `/archive` codec),
  `isArchive` (whether a decoded `DocumentReference` is an archive of _this_
  format, disjoint across formats), `archiveFromDocumentReference` (the
  bytes-and-name reader a preview or a pick calls to re-hydrate one), and
  `archiveContentType` (drives the preview modal's renderer choice: PDF via
  `<iframe>`, JSON via `<pre>`).
  The decode's result is a **`DecodedFile<TParsed>`**: titled
  **`LabeledSection`**s of **`LabeledResource`**s (stable `key`, one-line
  `title`, the parsed `resource`) plus file-level diagnostic note strings for
  what did not become a resource. **`sectionResources`** flattens the sections
  in order — the list the review transitions and the confirm fold over.
  **`SettingsPickerProps<TSettings>`** (the `{ settings, onChange }` contract
  every format's settings picker renders against) also lives here, below
  every format's React package. Settings are pre-decode input: a change
  re-decodes the file, so resource keys must be stable across settings
  changes where the underlying resource is unchanged.
- `src/review.ts` — the **`Review`** namespace, the pure per-resource
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
- `src/source-archive-codec.ts` — **`sourceArchiveCodec(config)`**, the one
  definition of how any uploaded source file is stored as a FHIR R4
  `DocumentReference` (one attachment carrying the bytes verbatim, `subject`
  deliberately absent). The HAR and LifeLabs codecs were identical bar their
  coding, content type, description text, and (HAR only) a `securityLabel`, so
  the shape lives here and each binding passes those in as **data** —
  `har-importer-core/archive` and `lifelabs-pdf-importer-core/archive` are now
  thin config + re-export shims. Returns the `Archive` schema (+ `ArchiveId`),
  both directions (`ArchiveFromDocumentReference` / `ArchiveFromFhirJson` and
  their `encode`/`decode`), the pure `toWire` builder, `isArchive`, the
  `categoryToken`, and **`sourceArchive`** — the descriptor's mint for a picked
  file: it derives a **deterministic** id from the bytes' SHA-256 and the file
  name via `fhir-r4/identity`'s `localResourceId` (so re-importing the same
  file upserts rather than duplicating), stamps the upload instant, and encodes.
  The mint lives here, not per binding, because the id needs the digest and the
  shared derivation, both of which this package owns (the per-binding
  `source-archive.ts` files that used to mint a uuid were folded in). A binding
  still owns its own coding constants (a HAR binding passes `web-trace-core`'s),
  so this module names no format and imports no format slice. The shared builder
  is pinned by `source-archive-codec.test.ts`, so a format's `/archive` test
  asserts only its own config.
- `src/sha256.ts` — **`sha256Base64`** (+ `DigestUnavailable`), the base64
  SHA-256 the archive attachment's `hash` carries, over Web Crypto. A verbatim
  copy of `web-trace-core`'s helper (the standard digest, no project-specific
  behaviour), kept here so the codec above needs no `web-trace-core` dependency
  — a copy, because moving it would invert the importer → web-trace direction.

## Layering

Depends on `effect` (and `kitchen-sink` in tests), plus `fhir-r4` for the
`DocumentReference` schema and `DocumentReferenceType`, and `fhir`'s wire
types. It used to name `fhir-r4` for `DocumentReferenceType` alone; hosting the
shared `sourceArchiveCodec` widened that to the `DocumentReference` runtime
schema (the codec builds and decodes the resource) — but still no client, no
other resource schemas, and no `persistResources`: the write sink stays at the
shell (`fhir-r4/clients`' `persistBatchBundle`) and the per-format extracted
resource type is still `TParsed`. It deliberately does **not** depend on
`web-trace-core` — the digest helper the codec needs is copied into `sha256.ts`
rather than imported, and a HAR binding passes web-trace's coding constants in
as data. Names no archive _format_ (each binding supplies `decode` and its
coding), no HTTP vocabulary (the HAR binding's
recognition machinery lives in `har-importer-core`), and no UI framework.
Never imports a `*-importer-core`, a `*-importer-react`, `slices/collector`,
or `slices/http-extraction`.

## Guardrails

- **Decode-at-preview, write-what-you-reviewed.** `decode` yields the actual
  resources the reviewer sees; the confirm writes `Review.chosenResources` —
  the same objects, filtered by the exclusions, with edits substituted — with
  no re-parse. This split is the whole point; do not collapse it.
- **Sections and notes are the whole review surface.** A format with routing
  decisions (HAR's kind toggles) expresses them as _settings_, and its decode
  folds everything that yielded no resources into notes — there is no
  per-format review state and no format review UI. Don't reintroduce either.
- **Selection keys by `LabeledResource.key`.** Selection state must be
  serializable and survive a settings re-decode, so both axes hold string
  keys; a key that disappears simply stops applying.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles and
  layering.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the HAR binding
  that implements this contract.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that lists
  descriptors and drives the `Review` transitions.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
