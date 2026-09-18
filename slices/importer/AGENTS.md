# AGENTS.md — slices/importer

The **importer**: the user-facing offering that turns a file the user picked
into FHIR resources in the on-device store, reviewed per-URL first and persisted
only on an explicit confirm. The slice is the app-facing flow plus per-file-format
import pipelines — HAR, LifeLabs PDF, and DICOM today; a future CSV importer joins as
a sibling pipeline wrapping a pure decode dialect, never touching
`slices/http-extraction`.
The HAR importer is the one format whose contents _are_ HTTP traffic, so it alone
reaches into the `http-extraction` slice to recognize which registered response
kinds claim each archived response and to extract with them.

The slice mirrors the collector slice's shape: a resource-agnostic
**fundamentals** package under a **format binding** (core + React), under a
pure **core** (the registry and the batch machinery) and a **shell**. See the [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
before adding a format.

Part of the offline FHIR HAR importer epic (#489).

## Package roles

Each package's own AGENTS.md is the authority on its shape; the roles:

- **[`importer-fundamentals`](./importer-fundamentals/AGENTS.md)**
  (resource-agnostic, format-agnostic) — the `FileImporter` contract and the
  `FileImporter.make` factory that builds one: a binding gives a
  `sourceFileFormat` (its coding constants) and a batch `decode` still needing
  that format's context — typically `DecodeFunction.fromPerFile` over its format
  tag and per-file `decodeOne` — and gets back a bound importer whose `decode`
  the shell runs (one `FormatDecode.Result` per format: the merged sections and
  notes, plus an `unreadableFiles` row per file that rejected), plus the
  deterministic source-file mint and its server-read seam, and the per-file
  review-key namespacing that keeps one claimed file's keys from colliding
  with another's. The factory binding the context is what keeps
  `sourceFileFormat` spelled once per binding. Also the `PickedFile`
  vocabulary, the `FormatDetector` seam the picker sniffs with, the `SourceFile`
  reference/decode vocabulary, and the pure per-resource `StagedImport` model.
  There is no `persist` sink: the write is the shell's one
  `persistBatchBundle`.
- **[`har-importer-core`](./har-importer-core/AGENTS.md)** (the HAR binding) —
  `harImporter` for format `'har'`: HAR decode through the
  pre-adopted FHIR response-kind pool into per-URL sections (with a note per
  response that yielded nothing), under the HAR source-file coding its importer
  mints from inside `decode`. The kind toggles are a _setting_
  (`HarSettings.disabledKinds`), applied inside `decode` too.
- **[`har-importer-react`](./har-importer-react/AGENTS.md)** (the HAR UI) —
  `HarSettingsPicker`, the whole-import kind toggles grouped by source. The
  format has no review UI of its own; the shell's generalized sectioned
  review covers it.
- **[`lifelabs-pdf-importer-core`](./lifelabs-pdf-importer-core/AGENTS.md)** (the
  LifeLabs PDF binding) — `lifeLabsPdfImporter` for format
  `'lifelabs-pdf'`: takes a picked LifeLabs report PDF's raw bytes end-to-end,
  running `positioned-text-web`'s extraction seam (the same one the PDF
  anonymizer uses) before the positioned-text dialect and the FHIR R4
  synthesis, under its own PDF source-file coding. Its decode yields one section
  per report the PDF carries; this format makes no HTTP routing decisions (no
  response-kind recognition; this format is documents, not archived HTTP
  traffic).
- **[`lifelabs-pdf-importer-react`](./lifelabs-pdf-importer-react/AGENTS.md)**
  (the LifeLabs PDF UI) — `LifeLabsPdfSettingsPicker` (the report's time zone).
- **[`dicom-importer-core`](./dicom-importer-core/AGENTS.md)** (the DICOM
  binding) — `dicomImporter` for format `'dicom'`: byte-level `.dcm`
  detection (DICM magic at offset 128 or `.dcm` extension), the source-file
  coding that stores a DICOM file as a FHIR `DocumentReference` filed under the
  Patient the decode synthesized (its `subjectFor` reads that Patient off the
  decode, so the file is parsed once), header tag parsing, and FHIR R4
  synthesis (Patient / ServiceRequest / ImagingStudy).
- **[`dicom-importer-react`](./dicom-importer-react/AGENTS.md)** (the DICOM
  UI) — `DicomSettingsPicker` (the acquiring equipment's time zone).
- **[`importer-core`](./importer-core/AGENTS.md)** (the pure core) — the closed
  importer registry (`FormatKind`, `FormatSettings`, `BoundFormat<K>`,
  `formatRegistry`, `defaultFormatSettings`, and `formatKinds` derived from the
  registry) and the batch machinery over it: `groupByFormat` splits a pick by
  the first claiming `detect`, `decodeFormat` runs one format's `decode` under
  its own settings, `readBatch` yields a `BatchDecodeResult` — one
  `FormatDecode.Result` per registered format plus the `UnrecognizedFile`s —
  `claimedFormats` names the formats that actually took part, `redecodeFormat`
  re-runs one format's files from their retained picks under new settings, and
  `planFormatWrite` turns a format's reviewed selection into the exact resource
  list to write. No DOM, no React, no client.
- **[`importer-react`](./importer-react/AGENTS.md)** (the shell) —
  `ImporterScreen`, the whole pick-review-confirm flow a host app mounts, plus
  the React half of the registry (each `importer-core` importer spread with
  that format's `SettingsPicker`) and the generalized sectioned review every format
  shares (per-resource include/edit with the inline JSON `ResourceEditor`),
  plus `ServerSourceFileList`, the uploaded-source-files pick source the
  anonymizer slice's shell takes through its `serverSource` slot.

A host that provides the FHIR write client and the authed runner sits above
`importer-react` and mounts `ImporterScreen` — the Importer web app pairs it
with the anonymizer slice's `AnonymizerScreen`
([slices/anonymizer](../anonymizer/AGENTS.md), home of the HAR anonymizer's
engine and panel) under one Import | Anonymize tabstrip.

## Why this slice is layered this way

The HAR import is assembled from pieces that each already have a home, and the
assembly belongs to none of them:

- **`http-extraction-fundamentals`** (in `slices/http-extraction`) owns the
  FHIR-agnostic machinery (`Extraction.routeTo` / `recognize` / `parseWith`,
  `HttpResponseKind`, `Specificity`) but names no archive format and no resource
  type.
- **`fhir-r4-source`** (same slice) owns the FHIR R4 source descriptor
  (`fhirR4Source`, its `responseKinds` pre-adopted) but knows nothing about HAR
  or about a registry of formats.
- **`web-trace-core`** (in `slices/web-trace`) owns the HAR codec but is
  deliberately consumer-agnostic.

`har-importer-core` is the one place those three meet: HAR text in, a per-URL
recognition against the FHIR pool, and an opt-in write out. `importer-fundamentals`
sits above `http-extraction` and below every binding, exactly as
`collector-fundamentals` does.

## Guardrails

- **The importer is per-URL, not per-archive.** Each response is recognized
  independently against the flat `pool` (highest specificity wins), so a mixed
  archive extracts every recognized URL — a stray FHIR URL inside a portal
  capture extracts, instead of being quarantined to one winning source. Nothing
  claims a whole archive for a single source; each response carries its own
  recognition.
- **The read half never writes.** `decode` requires no services — in
  particular not `FhirR4ResourcesHttpApiClient` — so reaching a review is a
  pure function of the file bytes and its format's settings, and the write
  client is unreachable from it by construction. Writing is the shell's one
  `persistBatchBundle`, gated on the user confirming a review. Parse runs at
  **preview** — `decode` yields the actual resources, sectioned, so the
  reviewer sees them and can opt any of them out or edit them inline;
  **writes** still only run at confirm, and confirm writes exactly those
  reviewed objects (`importer-core`'s `planFormatWrite`) with no re-parse — the same
  "is the same object" argument the anonymizer's preview makes. This split
  is the whole point; do not collapse it. A settings change (a HAR kind
  toggle, the LifeLabs time zone) re-runs `decode` from the retained bytes —
  still the read half.
- **The picker takes bytes, and identifies against every registered
  format.** A picked file is a name + raw bytes + its provenance (`local`,
  or `server` naming a source file already on the device): HAR is UTF-8 JSON, a
  LifeLabs report is a PDF, a DICOM file is binary, and every downstream step
  reads bytes. The picker runs each registered format's `detect` on every
  drop and yields the pick tagged with the first format that claims it, so
  a batch may span formats — `importer-core`'s `readBatch` groups the pick by
  format and runs each format's own batch `decode` under that format's
  settings. A format's `decode` mints its own source-file `DocumentReference`
  for each `local` pick, lists it among the reviewed sections, and stamps every
  extracted resource's `meta.source` with it; nothing above the binding mints
  or stamps anything. The write itself is format-blind — one shared
  `persistBatchBundle` at the shell.
- **The registry is closed and compile-time.** The importer registry is
  `importer-core`'s literal `{ har, 'lifelabs-pdf', dicom }`, and
  `importer-react`'s registry spreads each entry with that format's
  `SettingsPicker` — composition, not a subclass, so a field added to
  `FileImporter` cannot be silently dropped on the way through. Every slot is a
  mapped or exhaustive type over `FormatKind`, so a format missing one part
  fails to compile.
  Dispatch over the registry is generic (`<K extends FormatKind>`), not a
  `Match` branch per format — the one exhaustive match left is the preview
  panel's settings form. The review display is not a registry
  slot: every format is reviewed through the shell's one generalized
  sectioned view. Unlike the collector slice there is no separate registry
  package — the importer has no HTTP wire union to derive.
- **The slice imports only the accepted seams.** `har-importer-core` depends on
  `web-trace-core` for the HAR codec and the source-file coding constants only —
  the `meta.source` stamping and the source-file mint come from
  `importer-fundamentals` — plus `http-extraction-fundamentals`
  (extraction + recognition), `fhir-r4-source` (the pre-adopted pool),
  `importer-fundamentals` (the contract), and `fhir-r4` (resources). It
  re-derives none of them. Nothing here imports from `slices/collector`,
  in code or in concept.
- **A future file format gets its own binding, not a widened HAR one.** A CSV
  or another imaging import decodes a _document_: its decode belongs in a pure dialect package
  (the way rexall's carebook dialect and `web-trace-core`'s codec work), wrapped
  here by a sibling `*-importer-core` binding built on the same
  `FileImporter.make`. The dialect sits below both transports, which is what
  keeps the graph acyclic.

## References

- [Adding a File-Format Importer How-To](./docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the checklist for a new format binding.
- [importer-fundamentals AGENTS.md](./importer-fundamentals/AGENTS.md) — the
  `FileImporter` contract, the source-file seam, and the `StagedImport` model.
- [importer-core AGENTS.md](./importer-core/AGENTS.md) — the closed importer
  registry and the pure batch machinery the shell drives.
- [har-importer-core AGENTS.md](./har-importer-core/AGENTS.md) — the HAR binding's
  decode, pool, and source-file coding.
- [har-importer-react AGENTS.md](./har-importer-react/AGENTS.md) — the HAR
  settings picker (the response-kind toggles).
- [dicom-importer-core AGENTS.md](./dicom-importer-core/AGENTS.md) — the DICOM
  binding's detect, source file, and decode.
- [dicom-importer-react AGENTS.md](./dicom-importer-react/AGENTS.md) — the DICOM
  settings picker (the equipment time zone).
- [importer-react AGENTS.md](./importer-react/AGENTS.md) — the shell, the
  registry's React half, and the pick-review-confirm flow.
- [slices/http-extraction/AGENTS.md](../http-extraction/AGENTS.md) — the
  vocabulary and source packages the HAR importer recognizes and extracts with.
- [web-trace-core AGENTS.md](../web-trace/web-trace-core/AGENTS.md) — the HAR
  codec (the `HttpArchive` namespace) and the coding constants the HAR source
  file shares an axis with.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
