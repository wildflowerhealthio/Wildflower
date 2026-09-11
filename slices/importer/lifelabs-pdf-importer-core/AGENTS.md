# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice (core layer): the descriptor
opens a picked LifeLabs "Reports" PDF's raw bytes end-to-end. It threads the
same `positioned-text-web` extraction seam the PDF anonymizer uses, runs the
positioned-text dialect over the extracted `wildflower-positioned-text`
document to typed `LifeLabsReport` records, and synthesizes Patient,
Practitioner, DiagnosticReport, and Observation FHIR resources — the
importer's opt-in write happens through the descriptor's `persist` afterwards.
The picker's user hands in the PDF itself, not the anonymizer's JSON output:
this binding does its own extraction.

The core stays pure in the layering sense — no DOM, no `fs`, no React — but
depends on `positioned-text-web`, whose `extractPositionedText` reaches
`pdfjs-dist` behind a dynamic import. That is the one shared PDF extraction
seam in the repo; the anonymizer's PDF descriptor calls the same function.

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
  `Lab`, `TestTableRow`, `Group`, `Section`, `Report`). Each `<name>.ts` holds
  its `Type` (the report's own text, nothing interpreted) and — for the
  header-derived blocks — a `fromPageHeader` reader. `Report` additionally owns
  **`tryFromDocument`**, the parse of a whole positioned-text document into one
  `Report.Type` per `Lab No` (the orchestration over `document/`); it is an
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
  resources with deterministic ids (FNV-1a 64-bit hashes of length-prefixed
  identity components), grouped as one `ReportResources` per report — a
  `Patient` or `Practitioner` several reports share is minted once, in the
  group of the first report naming it, so flattening the groups in order
  writes every reference target before its referrer. The per-resource wire builders live in `wire/`:
  `wire/patient.ts`, `wire/practitioner.ts`, `wire/observation.ts`,
  `wire/diagnostic-report.ts`, with shared helpers (`sourceId`, `timingWire`,
  `reportStatus`, `performerWire`, `quantityWire`) in `wire/shared.ts`.
  Supporting modules: `dates.ts` (printed timestamps to FHIR `date` /
  `dateTime`), `reference-range.ts` (printed reference range to bounds),
  `result-value.ts` (printed result to quantity or text).
- `src/source-system.ts` — **`LIFELABS_SYSTEM`** and
  **`LifeLabsIdentifierSystem`**: the source-system URI and the identifier
  systems the synthesis writes beside the report's own numbers. A leaf module
  so the descriptor, the response kind, and the FHIR synthesis import it
  without a cycle.
- `src/decode.ts` — **`decodeLifeLabsPdf`** (the descriptor's `decode`) and
  **`decodeLifeLabsPdfDocument`** (the pure "document ↦ sections" leg tests
  drive directly). `decodeLifeLabsPdf(pdfBytes, settings)` calls
  `positioned-text-web`'s `extractPositionedText` on the raw bytes and hands
  the extracted `Document.Type` to `decodeLifeLabsPdfDocument`, which runs the
  dialect, the FHIR synthesis, and adoption, yielding a `DecodedFile`: one
  `LabeledSection` per report, titled by **`reportSectionTitle`** (the
  report's `Lab No` and date of service, `'LifeLabs report'` when both are
  masked), and no notes. Both extraction failure and an unrecognized
  LifeLabs document surface as `ParseError` — the descriptor contract's one
  error channel.
- `src/detect.ts` — **`detectLifeLabsPdf`**, the descriptor's `detect`:
  `%PDF-` magic bytes or a `.pdf` extension. Kept syntactic so the picker can
  call every registered format's `detect` on every drop; the real recognition
  is `decode`.
- `src/persist-fhir.ts` — **`persistFhir`**, the descriptor's `persist`: stamps
  every resource with `meta.source` then delegates to `fhir-r4`'s
  `persistResources`.
- `src/archive/` — **the FHIR encoding of an uploaded LifeLabs report PDF**
  as a `DocumentReference`, exported as the `/archive` subpath. Structurally
  analogous to `har-importer-core/archive` (differences: PDF content type,
  LifeLabs coding under `LIFELABS_SYSTEM|lifelabs-pdf-archive`, no
  web-trace security label). Nothing here parses the PDF; the bytes are
  carried, hashed, and handed back exactly as they arrived. Every
  imported resource stamps this archive's reference onto `meta.source` —
  the provenance link that ties a `Patient`/`DiagnosticReport`/
  `Observation` back to the raw source PDF.
- `src/upload-source.ts` — **`uploadSource`**, the descriptor's
  `uploadSource`: mint uuid + upload instant, encode via the archive
  codec, PUT, return the `DocumentReference/<id>` reference. Same shape
  as HAR's; the shared shape is a candidate for factoring when a third
  source-archive format lands.
- `src/descriptor.ts` — **`lifeLabsPdfImporterDescriptor`**, the concrete
  `FileImporterDescriptor` for format `'lifelabs-pdf'`. `accept` is only the
  PDF tokens (`.pdf`, `application/pdf`); what `decode` returns is what the
  user reviews — this format has no routing decisions to interpose.
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

Depends on `positioned-text` (the positioned-text schema — the neutral seam
between extraction and the dialect), `positioned-text-web`
(`extractPositionedText`, the shared pdfjs seam the anonymizer also drives),
`fhir-r4` (resource schemas, `persistResources`, `joinIdComponents`,
`adoptResource`), `importer-fundamentals` (`FileImporterDescriptor`,
`LabeledResource`), `web-trace-core` (`withMetaSource`), `kitchen-sink`
(`fnv1a64` for deterministic id hashing, `numRunsFor` in tests), and `effect`
(peer; `Report.tryFromDocument` returns an `Effect`). `fast-check` is a
test-only `devDependency`, reached only from the `*-arbitrary.ts` modules,
and must stay out of the production bundle. Never imports `har-importer-core`,
`pdf-anonymizer-core`, `http-extraction-fundamentals`, a `*-importer-react`,
or `slices/collector`.

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
  the page footer and the date of service.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [positioned-text AGENTS.md](../../file-formats/positioned-text/AGENTS.md)
  — the positioned-text schema this dialect parses.
