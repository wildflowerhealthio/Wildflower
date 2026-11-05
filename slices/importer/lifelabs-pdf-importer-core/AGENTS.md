# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice, and its pure layer. The
importer opens a picked LifeLabs "Reports" PDF's raw bytes end-to-end. Its
decode asks `positioned-text`'s `PositionedTextExtractor` service for the
PDF's text, runs the positioned-text dialect over the extracted
`wildflower-positioned-text` document to typed `LifeLabsReport` records, and
synthesizes Patient, Practitioner, DiagnosticReport, and Observation FHIR
resources — the importer's opt-in write happens through the shell's shared
`persistBatchBundle` afterwards.
The picker's user hands in the PDF itself, not the anonymizer's JSON output:
this binding does its own extraction.

It holds no DOM code, no `fs`, no React and no extraction library. The
extractor is a requirement of the decode's `Effect`, so it reaches the caller
through `FileImporter.Type`'s `R` and `importer-core`'s `readBatch`. The host
provides `positioned-text-web`'s `positionedTextExtractorPdfjs`, the same pdfjs
extraction the anonymizer's PDF format descriptor calls; tests provide a fake
that hands back a hand-written positioned-text document.

## Shape

- `src/document/` — **the positioned-text dialect's region parsers**, the read
  half's toolkit. `table.ts` clusters a page's runs into visual lines
  (`LINE_TOLERANCE` = 5.5pt: a label and its differently-sized value share a
  line, consecutive grid rows 9pt apart never do); `column.ts` names the grid's
  column bands by `x` (section 0 · group ~14 · test name ~28 · flag ~255 ·
  result/comment ~283 · reference range ~391 · unit ~485 · lab licence ~586);
  `page-header.ts` is the per-page header shape, its `get` accessor, and
  `fromLines`; `page-footer.ts` reads the `Page n of N` index, status line, and
  footer notes; `page-parts.ts` (`split`) cuts one page into header / grid body
  / footer; `grid.ts` (`Grid`) is the mutable per-report grid accumulator
  (`create` / `read` / `freeze`, opaque state) fed line by line (section →
  group → row → comment); `printed-text.ts` holds the shared `fast-check` text
  primitives the entity arbitraries use.
- `src/entities/` — **the report model, one namespace per shape** (`Patient`,
  `Lab`, `LabNumber`, `TestTableRow`, `Group`, `Section`, `Report`). Each
  `<name>.ts` holds its `Type` (the report's own text, nothing interpreted)
  and — for the header-derived blocks — a `fromPageHeader` reader.
  `LabNumber` is a printed `Lab No`, a branded string that is never blank:
  `LabNumber.make` is how a caller building a report itself spells one.
  `Report` additionally owns **`tryFromDocument`**, the parse of a whole
  positioned-text document into `DocumentReports`: one `Report.Type` per run
  of pages sharing a `Lab No` (the orchestration over `document/`), beside
  `pagesWithoutLabNo`, the pages it skipped for printing none. It is an
  `Effect` that fails with `UnrecognizedLifeLabsDocument` when a non-empty
  document carries no `Lab No` or grid heading on any page, and otherwise reads
  totally (masked fields → `''`, no grid → no sections). `TestTableRow` is a
  printed grid line, structural not clinical (a `Collection Date` line is a
  `TestTableRow`, not an observation) — the FHIR synthesis layer mints the
  clinical `Observation`. Each shape's `fast-check` `arbitrary` lives in a
  test-only `<name>-arbitrary.ts` sibling, never imported by production code, so
  `fast-check` stays out of the bundle.
- `src/fhir/` — **the FHIR R4 synthesis** that converts parsed reports into
  standard resources. `to-fhir.ts` (`toFhirResources`) is the orchestrator:
  it validates each wire object through the `fhir-r4` schema decoders and
  emits `Patient`, `Practitioner`, `DiagnosticReport`, and `Observation`
  resources detached, each keyed by a real identifier the report prints
  (see `source-system.ts`), grouped as one `ReportResources` per report, each
  resource an entry whose `fullUrl` is `<Type>/<key value>` — a
  `Patient` or `Practitioner` several reports share (one key) is minted once,
  in the group of the first report naming it, so flattening the groups in
  order writes every reference target before its referrer. The keys:
  the Patient's printed `Patient ID`, else its health card number less its
  version code (the letters after the number, so a reissued card keys the
  same Patient), else `<name>, <date of birth>` as printed (`patientKeyOf`,
  the other printed identifiers behind the key); the `DiagnosticReport`'s
  `Lab No` (`reportKeyOf`); a result row's
  `<Lab No>/<section>/<test name>/<ordinal>` (`observationKeyOf`); a
  provider's printed name, inner whitespace collapsed (`practitionerKeyOf`).
  The per-resource wire builders live in `wire/`:
  `wire/patient.ts`, `wire/practitioner.ts`, `wire/observation.ts`,
  `wire/diagnostic-report.ts`, with shared helpers (`timingWire`,
  `reportStatus`, `performerWire`, `quantityWire`) in `wire/shared.ts`.
  `printings.ts` picks the printing of a `Lab No` the synthesis keeps when a
  file prints it more than once (`latestPrintingOf`: the latest
  `Reported on:`, else the one printed later in the file) and words the note
  (`keptPrintingNote`).
  Supporting modules: `dates.ts` (printed timestamps to FHIR `date` /
  `dateTime`), `reference-range.ts` (printed reference range to bounds),
  `result-value.ts` (printed result to quantity or text), `printed-number.ts`
  (the printed-number grammar and reading those two share), `units.ts` (the
  LifeLabs display-unit → UCUM mapping `quantityWire` stamps as
  `Quantity.system` / `Quantity.code` beside the printed spelling; a spelling
  not in the table is carried as `unit` alone rather than guessing a code).
- `src/source-system.ts` — **`LIFELABS_SYSTEM`** and
  **`LifeLabsIdentifierSystem`**: the source file's coding system, and the
  identifier systems the synthesis keys its records in — the printed
  `Lab No`, `Patient ID` and Ontario health card number (less its version
  code), and the
  Wildflower-minted name-and-birth-date, result and practitioner-name
  systems for what the report prints no number for. A leaf module so the
  importer and the FHIR synthesis import it without a cycle.
- `src/decode.ts` — **`decodeLifeLabsPdf`** (the `decodeFileSet` the format's
  importer lifts into its batch `decode`) and **`decodeLifeLabsPdfDocument`** (the pure
  "document ↦ sections" leg tests drive directly).
  `decodeLifeLabsPdf(file, settings)` requires a `PositionedTextExtractor`,
  runs its `extract` on the picked file's bytes
  and hands the extracted `Document.Type` to `decodeLifeLabsPdfDocument`,
  which runs the
  dialect, then `synthesis.ts`'s `decodedReportsOf`, and adds a note for each
  page skipped for printing no `Lab No`
  (`Page 3 prints no Lab No, so it was skipped.`). The import stage
  adopts the records.
  Both extraction failure (`UnreadablePdf`) and an unrecognized LifeLabs
  document surface as `ParseError` — the one error channel the batch decode folds into that file's
  `unreadableFiles` entry. It reads only the picked file's name and bytes: this
  format derives no id from its source file, and the import stage does the
  `meta.source` stamping.
- `src/synthesis.ts` — **the FHIR synthesis without the PDF decoder**,
  exported as the `/synthesis` subpath: the `Report` model's types and
  `LabNumber`, `toFhirResources`, **`decodedReportsOf`**
  (the reports as the decode yields them: only the latest printing of each
  `Lab No`, in the order each `Lab No` is first printed, with a note naming
  each `Lab No` printed more than once and the printing kept; the synthesis,
  its records written
  detached and keyed by what the report prints, one section per
  report titled by **`reportSectionTitle`** (the report's `Lab No`, and its
  date of service when it prints one), each entry's
  `fullUrl` `<Type>/<key value>`)
  and the
  `ReportResources` / `SynthesisOptions` types, none of which requires an
  extractor. For callers that build reports themselves
  (`synthetic-data-lifelabs`, which adopts `decodedReportsOf`'s decode with
  `DecodedFileSet.adopt`, as the import stage does). The main entry re-exports only
  `reportSectionTitle`: it carries the importer's own surface (decode,
  detect, the importer, `Report`, the settings and the source-system
  constants).
- `src/detect.ts` — **`detectLifeLabsPdf`**, the importer's `detect`:
  `%PDF-` magic bytes or a `.pdf` extension. Kept syntactic so the picker can
  call every registered format's `detect` on every drop; the real recognition
  is `decode`.
- `src/source-file.ts` — **the coding axis an uploaded LifeLabs report PDF is
  stored under**, exported as the `/source-file` subpath: a narrowing of
  `source-system.ts` to `LIFELABS_SYSTEM`, `LIFELABS_PDF_SOURCE_FILE_CODE`, and
  `LIFELABS_PDF_SOURCE_FILE_CONTENT_TYPE` — not `LifeLabsIdentifierSystem`,
  which the FHIR synthesis uses and this seam has no business exposing. The
  FHIR encoding is not written
  here — `lifelabs-pdf-importer.ts` states those constants as its
  `sourceFileFormat` (PDF content type, LifeLabs coding under
  `LIFELABS_SYSTEM|lifelabs-pdf-source file`, no web-trace security label) and
  gets the read-back, and the import stage's mint, derived from them. Nothing parses the PDF on
  that path; the bytes are carried, hashed, and handed back exactly as they
  arrived. The mint derives a deterministic id from the file's SHA-256 and
  name, and encodes to a `DocumentReference` —
  **no PUT**; the shell writes it in the same `persistBatchBundle` as the
  synthesized resources. Same shape as HAR's.
- `src/lifelabs-pdf-importer.ts` — **`lifeLabsPdfImporter`**, the
  `FileImporter.Type` literal for format `'lifelabs-pdf'`, its `decode` a
  `DecodeFunction.make` with `decodeLifeLabsPdf` as its `decodeFileSet` — no
  `groupBy` (a report stands alone), and it states no `linkSourceFile`. Its
  `R` is `PositionedTextExtractor`. The batch decode it returns folds a file
  whose bytes yield no report into that file's `unreadableFiles` entry; the
  import stage mints every pick's source file `DocumentReference`, reviews it
  as its own "Source file" section, and stamps every synthesized resource's
  `meta.source` with it. What the import returns is what the user reviews —
  this format has no routing decisions to interpose, and the write is the
  shell's one `persistBatchBundle`, not an importer field.
- `src/settings.ts` — **`LifeLabsPdfSettings`** `{ timeZone }`, default
  `America/Toronto`: the report prints local clock times with no zone, and
  FHIR's `dateTime`-with-time / `instant` need one. The zone is passed to
  `decode` as a setting.
- `src/test-helpers.ts` (`./test-helpers` subpath) — `layoutReport` /
  `layoutDocument`, the print's inverse: a `LifeLabsReport` laid out as
  positioned text at the real column x's, header labels and footer. The
  dialect is pinned as `Report.tryFromDocument ∘ layoutReport = id` over the
  reports `entities/report-arbitrary.ts` generates.

## Layering

A `-core`: pure, `lib: ["es2024"]` with no DOM, and no adapter among its
dependencies, directly or through other packages. Depends on
`positioned-text` (the positioned-text schema, the neutral seam between
extraction and the dialect, and the `PositionedTextExtractor` service the
decode requires), `fhir-r4` (resource schemas), `fhir-r4-adoption` (`DetachedResource`),
`importer-fundamentals` (`DecodeFunction.make`, `DecodedFileSet`, `PickedFile`),
`kitchen-sink`
(`checkTimeZone`, `numRunsFor` in tests), and `effect`
(peer; `Report.tryFromDocument` returns an `Effect`). `fast-check` is a
test-only `devDependency`, reached only from the `*-arbitrary.ts` modules,
and must stay out of the production bundle. Never imports `har-importer-core`,
`pdf-anonymizer-core`, `http-extraction-fundamentals`, `positioned-text-web`,
`pdfjs-dist`, or a `*-importer-react`.

## Guardrails

- **The dialect interprets nothing.** A `ReportRow.result` is the printed
  string; deciding it is a quantity is the FHIR synthesis layer's job
  (`src/fhir/`). Keep that split — it is what makes the round-trip property
  possible.
- **Every grid row is a row**, `Collection Date` and `Reference Interval Note`
  included: each is a line the report prints, and deciding some are metadata
  would drop them silently.
- **A masked field is absent, not invented.** The anonymizer's `Xxx 00 0000`
  reads as no date of birth; a masked lab number that repeats is told apart by
  the page footer (each report starts at its own `Page 1 of N`), so reports
  that share a lab number stay separate reports in the parse.
- **One `Lab No`, one report.** A page that prints no `Lab No` is skipped in
  the parse, and noted. Reports printing one `Lab No` are printings of one
  report, and the synthesis keeps only the latest, whole, noting which; a
  masked export, every lab number masked to the same digits, keeps one
  report. So every record of a LifeLabs file set has its own key and
  `fullUrl`.
- **A key is a real identifier, never a digest.** What the report prints,
  in a system named for it, or a Wildflower-minted system over printed text
  for what it prints no number for.
- **Every key is persisted wire format.** The id a record is stored under
  derives from its key, so changing a system or how a value is spelled
  re-keys every LifeLabs record of that type already imported.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [positioned-text AGENTS.md](../../file-formats/positioned-text/AGENTS.md)
  — the positioned-text schema this dialect parses.
