# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice (core layer): the
positioned-text dialect that reads a LifeLabs patient "Reports" PDF's
pages — extracted to the `wildflower-positioned-text` document the PDF
anonymizer (`slices/anonymizer/pdf-anonymizer-*`) produces and downloads —
into typed `LifeLabsReport` records, and the FHIR R4 synthesis that converts
them to standard resources. No DOM, no `fs`, no React.

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
  it builds wire objects from the report model, validates each through the
  `fhir-r4` schema decoders, and emits `Patient`, `Practitioner`,
  `DiagnosticReport`, and `Observation` resources with deterministic ids
  (FNV-1a 64-bit hashes of length-prefixed identity components). Supporting
  modules: `dates.ts` (printed timestamps to FHIR `date` / `dateTime`),
  `reference-range.ts` (printed reference range to bounds), `result-value.ts`
  (printed result to quantity or text).
- `src/source-system.ts` — **`LIFELABS_SYSTEM`** and
  **`LifeLabsIdentifierSystem`**: the source-system URI and the identifier
  systems the synthesis writes beside the report's own numbers. A leaf module
  so the descriptor, the response kind, and the FHIR synthesis import it
  without a cycle.
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
between the anonymizer's extraction and this dialect), `effect` (peer;
`Report.tryFromDocument` returns an `Effect`), `fhir-r4` (peer; the FHIR R4
resource schemas, identity helpers, and datatype definitions the synthesis
validates against), and `kitchen-sink` (`fnv1a64` for deterministic id hashing,
`numRunsFor` in tests). `fast-check` is a test-only `devDependency`, reached
only from the `*-arbitrary.ts` modules, and must stay out of the production
bundle. Never imports `har-importer-core`, `pdf-anonymizer-core`, a
`*-importer-react`, or `slices/collector`.

## Guardrails

- **The dialect interprets nothing.** A `ReportRow.result` is the printed
  string; deciding it is a quantity is `fhir/result-value.ts`'s job. Keep that
  split — it is what makes the round-trip property possible.
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
