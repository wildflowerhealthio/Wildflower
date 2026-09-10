# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice (core layer): the
positioned-text dialect that reads a LifeLabs patient "Reports" PDF's
pages — extracted to the `wildflower-positioned-text` document the PDF
anonymizer (`slices/anonymizer/pdf-anonymizer-*`) produces and downloads —
into typed `LifeLabsReport` records, the FHIR R4 synthesis that turns those
records into Patient, Practitioner, DiagnosticReport and Observation resources,
the `FileImporterDescriptor` binding, and the decode/persist integration.
No DOM, no `fs`, no React.

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
- `src/fhir/` — **the FHIR R4 synthesis**: `dates.ts` parses LifeLabs printed
  dates (`Mon D YYYY[ HH:MM]`) into FHIR dateTime/date values; `reference-range.ts`
  parses printed reference ranges into low/high bounds; `result-value.ts` parses
  printed result cells into quantity (with optional comparator) or text values;
  `to-fhir.ts` is the main synthesis — `toFhirResources` converts
  `Report.Type[]` → `FhirResource[]` (Patient, Practitioner, DiagnosticReport,
  Observation), keying each resource by a deterministic `sourceId` (FNV-1a hash
  of length-prefixed components) so re-imports of the same report produce the
  same ids.
- `src/source-system.ts` — **`LIFELABS_SYSTEM`**, the source system URI every
  resource is keyed under after adoption, and **`LifeLabsIdentifierSystem`**,
  the identifier systems for lab numbers, patient IDs, and health card numbers.
- `src/decode.ts` — **`decodeLifeLabsPdf`**, the descriptor's `decode`: a
  positioned-text JSON file in, one `Extraction.Input` carrying the file
  verbatim as its body under a minted URL, with the time-zone setting on a
  response header.
- `src/response-kind.ts` — **`LifeLabsReportResponseKind`** and the adopted
  `lifeLabsPdfResponseKinds`: the `HttpResponseKind` that claims the minted URL
  and parses the body through the dialect and the FHIR synthesis.
- `src/persist-fhir.ts` — **`persistFhir`**, the descriptor's `persist`: stamps
  every resource with `meta.source` then delegates to `fhir-r4`'s
  `persistResources`.
- `src/source.ts` — **`lifeLabsPdfSource`**, the `SourceDescriptor` the
  descriptor's `sources` entry, so the review menu labels the import by source.
- `src/descriptor.ts` — **`lifeLabsPdfImporterDescriptor`**, the concrete
  `FileImporterDescriptor` for format `'lifelabs-pdf'`.
- `src/settings.ts` — **`LifeLabsPdfSettings`** `{ timeZone }`, default
  `America/Toronto`: the report prints local clock times with no zone, and
  FHIR's `dateTime`-with-time / `instant` need one. The zone rides from
  `decode` to `parse` on the response header because `parse` sees the response,
  not the settings.
- `src/test-helpers.ts` (`./test-helpers` subpath) — `layoutReport` /
  `layoutDocument`, the print's inverse: a `LifeLabsReport` laid out as
  positioned text at the real column x's, header labels and footer. The
  dialect is pinned as `Report.tryFromDocument ∘ layoutReport = id` over the
  reports `entities/report-arbitrary.ts` generates.

## Layering

Depends on `positioned-text` (the positioned-text schema — the neutral seam
between the anonymizer's extraction and this dialect), `fhir-r4` (resource
schemas, `persistResources`, `joinIdComponents`, `adoptUnderRecognizedRoot`),
`http-extraction-fundamentals` (`Extraction.Input`, `HttpResponseKind`,
`SourceDescriptor`, `recognizePortal`), `importer-fundamentals`
(`FileImporterDescriptor`), `web-trace-core` (`withMetaSource`),
`kitchen-sink` (`fnv1a64`, `numRunsFor` in tests), and `effect` (peer).
`fast-check` is a test-only `devDependency`, reached only from the
`*-arbitrary.ts` modules, and must stay out of the production bundle. Never
imports `har-importer-core`, `pdf-anonymizer-core`, a `*-importer-react`, or
`slices/collector`.

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
