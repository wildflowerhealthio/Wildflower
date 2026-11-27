# AGENTS.md — slices/importer

The **importer**: the user-facing offering that turns a file the user picked
into FHIR resources in the on-device store, planned record by record first and
written only on an explicit Import. The slice is the app-facing flow plus per-file-format
import pipelines — HAR, LifeLabs PDF, and DICOM today; a future CSV importer joins as
a sibling pipeline wrapping a pure decode dialect, never touching
`slices/http-extraction`.
The HAR importer is the one format whose contents _are_ HTTP traffic, so it alone
reaches into the `http-extraction` slice to recognize which registered response
kinds claim each archived response and to extract with them.

The slice is layered as a mostly resource-agnostic
**fundamentals** package under a **format binding** (core + React), under a
pure **core** (the registry and the batch machinery) and a **shell**. See the [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
before adding a format.

The Importer web app that mounts the shell is
[`apps/importer-web`](../../apps/importer-web/AGENTS.md), published at
<https://importer.wildflowerhealth.io/>. The Synthetic Data Loader proves its
generators through the same `importer-fundamentals` and format bindings.

Part of the offline FHIR HAR importer epic (#489).

## Vocabulary

- **Pick**: one file the user picked, its name and bytes (`PickedFile`).
- **Batch**: everything picked in one go — all the picks, across every
  format, planned together and imported as one write.
- **File set**: the picks one format decodes together (`DecodedFileSet`): a
  single file for HAR and LifeLabs, a study's files for DICOM.
- **Review group**: what the old, unmounted review shows of one format, every
  file set of it adopted (`ReviewGroup`).

A batch holds picks; each format claims its picks (`claimPicks`) into file
sets; each format's file sets become one review group, and the records the
batch only links to are one more group, the linked records.

## Package roles

Each package's own AGENTS.md is the authority on its shape; the roles:

- **[`importer-fundamentals`](./importer-fundamentals/AGENTS.md)**
  (format-agnostic; resource-agnostic but for one FHIR import rule in
  `DecodedFileSet.adopt`, where a `MedicationDispense` with no `subject`
  takes its prescription's) — the `FileImporter` contract (an interface a binding
  writes as a literal, with its `sourceFileFormat` coding constants and
  optional `linkSourceFile` and `linkToSourceFiles` hooks) and
  `DecodeFunction.make`, the one constructor of a format's `decode`: a binding
  gives how one file set decodes (`decodeFileSet`) and — only if its files
  are read together — the key they share (`groupBy`). Back comes one
  `FormatDecode.Decoded` per format: each file set apart (`DecodedFileSet`:
  its picked files, its records in sections (`SectionedList`) under local keys
  unique within the set, and its notes), plus an `unreadableFiles` row per
  picked file that rejected. `DecodedFileSet.adopt` is the import stage's
  step that gives each record its id and its review row (`ReviewRow`), keyed
  by the set's key prefix before its local key, so one set's keys cannot
  collide with another's. Also the `PickedFile` vocabulary and the codec that stores a
  pick as a source file and reads it back, the `FormatDetector` seam
  the picker sniffs with, the pure per-resource `StagedImport` model, and the
  **identity map**: the referents a batch names, the `LinkChoice` per referent
  and the `MentionLinkChoiceSet` for single mentions, `StoredCandidates` (the
  stored candidates of a batch's resources, from one match against the store,
  which each referent's default reads through `ReferentMatch`), `StoredCopy`
  (a resource's stored copy, which the server diff compares it with), the
  **import plan** (`ImportPlan`: one choice per record across files, each
  suggested from what the store holds of it, resolved by those choices into
  a `PlanResolution` and written as one `ImportWrite`, and its `PlanTotals`;
  entities and the operations over them, in two folders), and the
  pure phases that
  resolve a batch's decoded rows on those choices (`LinkPlan`,
  `FileResolution`). There is no `persist` sink: the write is the shell's one
  `persistTransactionBundle`.
- **[`har-importer-core`](./har-importer-core/AGENTS.md)** (the HAR binding) —
  `harImporter` for format `'har'`: HAR decode through the
  FHIR response-kind pool into per-URL sections of detached records (with a
  note per response that yielded nothing), under the HAR source-file coding the import
  stage mints its source files with. Each response routes to its top-ranked
  kind, so the format has no settings (its `TSettings` is `null`) and no
  React package: the shell's import plan page covers it.
- **[`lifelabs-pdf-importer-core`](./lifelabs-pdf-importer-core/AGENTS.md)** (the
  LifeLabs PDF binding) — `lifeLabsPdfImporter` for format
  `'lifelabs-pdf'`: takes a picked LifeLabs report PDF's raw bytes end-to-end,
  reading their text through `positioned-text`'s `PositionedTextExtractor`
  service (which `importer-react` provides with `positioned-text-web`'s pdfjs
  layer, the extraction the PDF anonymizer uses) before the positioned-text
  dialect and the FHIR R4 synthesis, under its own PDF source-file coding. Its decode yields one section
  per report the PDF carries; this format makes no HTTP routing decisions (no
  response-kind recognition; this format is documents, not archived HTTP
  traffic).
- **[`lifelabs-pdf-importer-react`](./lifelabs-pdf-importer-react/AGENTS.md)**
  (the LifeLabs PDF UI) — `LifeLabsPdfSettingsPicker` (the report's time zone and health card province).
- **[`dicom-importer-core`](./dicom-importer-core/AGENTS.md)** (the DICOM
  binding) — `dicomImporter` for format `'dicom'`: byte-level `.dcm`
  detection (DICM magic at offset 128 or `.dcm` extension), the source-file
  coding that stores a DICOM file as a FHIR `DocumentReference` filed under
  the Patient the decode synthesized and related to the `ImagingStudy` it was
  read into, header tag parsing, and FHIR R4 synthesis (Patient /
  ServiceRequest / ImagingStudy). The one format that states a **`groupBy`**:
  its decode groups a pick by `StudyInstanceUID` (and patient) and yields one
  `ImagingStudy` per study, with one source file per file.
- **[`dicom-importer-react`](./dicom-importer-react/AGENTS.md)** (the DICOM
  UI) — `DicomSettingsPicker` (the acquiring equipment's time zone).
- **[`importer-core`](./importer-core/AGENTS.md)** (the pure core) — the closed
  importer registry (`FormatKind`, `FormatSettings`, `BoundFormat<K>`,
  `formatRegistry`, `defaultFormatSettings`, and `formatKinds` derived from the
  registry) and the batch machinery over it: `claimPicks` splits a batch's
  picks by the first claiming `detect`, `decodeFormat` runs one format's
  `decode` under its own settings and imports it through `importDecoded` — the
  import stage, the one place a detached record is adopted, which mints each
  set's source files and stamps `meta.source` through the steps it shares
  with `fileCopiesOf` — `readBatch` yields a `DecodedBatch` —
  one `ReviewGroup` per claimed format, each holding the picks it was read
  from, and the `UnrecognizedFile`s; a format took part exactly when it has a
  group — `redecodeFormat` re-runs one format's picks, as its group holds
  them, under new settings,
  `discoverReferents` and `resolveMentions` lift the identity map over the
  whole batch (one referent per identity across formats, one plan, a
  `ResolvedBatch` whose groups are the resolved formats' and the batch's
  linked records'), and
  `planWrite` turns the batch's reviewed selections into a `WriteDecision` per
  reviewed resource, the `Included` ones exactly the resources to write.
  `fileCopiesOf` reads a format's decode as copies of records, placed,
  linked and stamped by the import stage's own steps with no reference
  between a set's records resolved, and `readBatchCopies` reads a picked
  batch into each claimed format's copies with it; `findStoredMatch`
  matches an import once against the store, `noStore` against none;
  `planImport` builds its `ImportPlan`; `importWithSuggestions` imports a
  picked batch with no reviewer, every suggestion taken, and gives back the
  resources of one transaction for the caller to persist. No DOM and no React; the one
  client it asks is the store's (`FhirR4ResourcesHttpApiClient`), which
  `findStoredMatch` requires, and `planImport` and `importWithSuggestions`
  when handed it.
- **[`importer-react`](./importer-react/AGENTS.md)** (the shell) —
  `ImporterScreen`, the whole flow a host app mounts: choose files, read them
  into an import plan against the existing records (`readBatchCopies`,
  `planImport` with `findStoredMatch`, `resolvePlan`), review the plan on the
  import plan page (its summary, its Needs a decision cards and its import
  bar), and write it as one transaction; plus the React half of the registry (each `importer-core`
  importer spread with that format's `SettingsPicker`, for a format that has
  settings). Also `ServerSourceFileList`, the uploaded-source-files pick
  source the anonymizer slice's shell takes through its `serverSource` slot.

A host that provides the FHIR write client and the authed runner sits above
`importer-react` and mounts `ImporterScreen` — the Importer web app
([apps/importer-web](../../apps/importer-web/AGENTS.md)) pairs it
with the anonymizer slice's `AnonymizerScreen`
([slices/anonymizer](../anonymizer/AGENTS.md), home of the HAR anonymizer's
engine and panel) under one Import | Anonymize tabstrip.

## Why this slice is layered this way

The HAR import is assembled from pieces that each already have a home, and the
assembly belongs to none of them:

- **`http-extraction-fundamentals`** (in `slices/http-extraction`) owns the
  FHIR-agnostic machinery (`Extraction.routeTo` / `recognize` / `parseWith`,
  `HttpResponseKind`, `Specificity`) but names no source file format and no resource
  type.
- **`fhir-r4-source`** (same slice) owns the FHIR R4 source descriptor
  (`fhirR4Source` and its `responseKinds`) but knows nothing about HAR
  or about a registry of formats.
- **`web-trace-core`** owns the HAR codec but is
  deliberately consumer-agnostic.

`har-importer-core` is the one place those three meet: HAR text in, a per-URL
recognition against the FHIR pool, and an opt-in write out. `importer-fundamentals`
sits above `http-extraction` and below every binding.

## Guardrails

- **The importer is per-URL, not per-archive.** Each response is recognized
  independently against the flat `pool` (highest specificity wins), so a mixed
  source file extracts every recognized URL — a stray FHIR URL inside a portal
  capture extracts, instead of being quarantined to one winning source. Nothing
  claims a whole archive for a single source; each response carries its own
  recognition.
- **The read half never writes.** `decode` requires no services — in
  particular not `FhirR4ResourcesHttpApiClient` — so what a file decodes to
  is a pure function of its bytes and its format's settings, and the write
  client is unreachable from it by construction. Planning the decoded records
  only searches and reads the store (`findStoredMatch`). Writing is the
  shell's one `persistTransactionBundle` of the resolved plan's write
  (`ImportWrite.of`), sent only when the reviewer presses Import, with no
  re-parse. This split is the whole point; do not collapse it. The import
  plan reads every format under its default settings. **Not mounted, awaiting #1466.** In the old
  review a settings change (the LifeLabs or DICOM time zone, the LifeLabs
  health card province) re-runs `decode` from the retained bytes — still the
  read half.
- **Identity is decided by the import plan, never by a format.** The copies
  of one record that several files bring are one record of the plan, matched
  once against the store (`findStoredMatch`), with one choice per record
  (save as new, merge into an existing record, or don't add) that every
  reference to it lands on when the plan is resolved. No format links
  anything itself: a format's job is to make each resource name its
  identity, by a literal to a resource the same decode emits or by a logical
  reference that states its `type` and carries an `identifier` with a
  `system` and a `value` (`Practitioner.tryReferenceFromName` in the
  source's own name system for a provider known only by a printed name; with
  a `display`, the import stage implies the record such a reference names
  when the set holds none). See the
  [Source Identity Explanation](../http-extraction/fhir-r4-adoption/docs/Source%20Identity%20Explanation.md#the-identity-map)
  for the model.
- **The old review links identity in one stage.** **Not mounted, awaiting #1466.** The patients
  and providers a batch names are linked to the device's by the identity
  map, a function from the decoded batch and the reviewer's link choices to
  a **resolved** batch: each referent's mentions are redirected to its link
  target, a decoded Patient or Practitioner linked to a stored one is
  replaced by it under the same review key, the stored or decoded resource
  assumes the identifiers of the referents linked to it, and the stored
  records the batch only links to are its linked records. The old review
  runs it as a memo (`importer-core`'s `resolveMentions`) and hands the
  resolved batch to its server diff, preview and confirm. Identity never
  enters the `StagedImport` selection, which keeps its two axes, exclusions
  and edits; a per-mention pick is a `MentionLinkChoiceSet` entry the plan
  resolves, not an edit.
- **The picker takes bytes, and identifies against every registered
  format.** A picked file is a name + raw bytes: HAR is UTF-8 JSON, a
  LifeLabs report is a PDF, a DICOM file is binary, and every downstream step
  reads bytes. Where the file came from rides nowhere — the read gives every
  pick its id and every pick is stored, and a file re-picked off the server
  mints the source file it came from, because the id is a hash of its bytes and its
  name. The picker runs each registered format's `detect` on every
  drop and yields the pick tagged with the first format that claims it, so
  a batch may span formats — `importer-core`'s `readBatchCopies` splits the batch by
  the format that claims each pick, runs each format's `decode` on the picks
  it claimed under that format's settings, and imports what it decoded: `importer-core`'s import stage mints
  each picked file's source file `DocumentReference` under the format's
  constants, lets the format link it to the records and the records to it,
  makes it a record of its file set, and stamps every extracted resource's `meta.source` with it;
  nothing else mints or stamps anything. Which files decode _together_ is its own business too:
  HAR and LifeLabs decode a file at a time, DICOM a whole study — the shell
  hands every claimed file to one `decode` either way, and the server
  source-file list hands on every row the reviewer selected without deciding
  what they make up. The write itself is format-blind — one shared
  `persistTransactionBundle` at the shell, of the resolved plan's write across
  every format, landing whole or not at all.
- **The registry is closed and compile-time.** The importer registry is
  `importer-core`'s literal `{ har, 'lifelabs-pdf', dicom }`, and
  `importer-react`'s registry spreads each entry with that format's
  `SettingsPicker` — composition, not a subclass, so a field added to
  `FileImporter` cannot be silently dropped on the way through. Every slot is a
  mapped or exhaustive type over `FormatKind`, so a format missing one part
  fails to compile. The picker slot is conditional per format: forbidden for a
  format whose settings are `null` (HAR), required for every other, so a
  format without one has no settings form.
  Dispatch over the registry is generic (`<K extends FormatKind>`), not a
  `Match` branch per format. The review display is not a registry
  slot: every format's records are shown by the shell's one import plan
  page. There is no separate registry
  package — the importer has no HTTP wire union to derive.
- **The slice imports only the accepted seams.** `har-importer-core` depends on
  `web-trace-core` for the HAR codec and the source-file coding constants only —
  the `meta.source` stamping and the source-file mint are `importer-core`'s
  import stage — plus `http-extraction-fundamentals`
  (extraction + recognition), `fhir-r4-source` (the pool), `fhir-r4-adoption`
  (`DetachedResource`),
  `importer-fundamentals` (the contract), and `fhir-r4` (resources). It
  re-derives none of them.
- **A future file format gets its own binding, not a widened HAR one.** A CSV
  or another imaging import decodes a _document_: its decode belongs in a pure dialect package
  (the way rexall's carebook dialect and `web-trace-core`'s codec work), wrapped
  here by a sibling `*-importer-core` binding built on the same
  `DecodeFunction.make`. The dialect sits below both transports, which is what
  keeps the graph acyclic.

## References

- [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the checklist for a new format binding.
- [importer-fundamentals AGENTS.md](./importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract, the source-file seam, the `StagedImport` model, and
  the identity map.
- [importer-core AGENTS.md](./importer-core/AGENTS.md) — the closed importer
  registry and the pure batch machinery the shell drives.
- [har-importer-core AGENTS.md](./har-importer-core/AGENTS.md) — the HAR binding's
  decode, pool, and source-file coding.
- [dicom-importer-core AGENTS.md](./dicom-importer-core/AGENTS.md) — the DICOM
  binding's detect, source file, and decode.
- [dicom-importer-react AGENTS.md](./dicom-importer-react/AGENTS.md) — the DICOM
  settings picker (the equipment time zone).
- [importer-react AGENTS.md](./importer-react/AGENTS.md) — the shell, the
  registry's React half, and the flow from choosing files to writing their
  import plan.
- [slices/http-extraction/AGENTS.md](../http-extraction/AGENTS.md) — the
  vocabulary and source packages the HAR importer recognizes and extracts with.
- [web-trace-core AGENTS.md](../web-trace-core/AGENTS.md) — the HAR
  codec (the `HttpArchive` namespace) and the coding constants the HAR source
  file shares an axis with.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
