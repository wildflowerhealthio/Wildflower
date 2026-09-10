# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice (core layer, dialect only):
the positioned-text dialect that reads a LifeLabs patient "Reports" PDF's
pages — extracted to the `wildflower-positioned-text` document the PDF
anonymizer (`slices/anonymizer/pdf-anonymizer-*`) produces and downloads —
into typed `LifeLabsReport` records. No DOM, no `fs`, no React.

The FHIR R4 synthesis, the importer descriptor, and the decode/persist
integration are added in a follow-up PR.

## Shape

- `src/dialect/` — **the positioned-text dialect**, the read half.
  `lines.ts` clusters a page's runs into visual lines (`LINE_TOLERANCE` = 5.5pt:
  a label and its differently-sized value share a line, consecutive grid rows
  9pt apart never do); `columns.ts` names the grid's column bands by `x`
  (section 0 · group ~14 · test name ~28 · flag ~255 · result/comment ~283 ·
  reference range ~391 · unit ~485 · lab licence ~586); `parse-report.ts` is
  `parseReports`: header labels read by label text within their block (patient
  block left, laboratory block right of x=480), the grid read line by line
  through a small builder (section → group → row → comment), pages grouped
  into reports by `Lab No` and the `Page n of N` footer. `report.ts` is the
  **`LifeLabsReport`** model — the report's own text, nothing interpreted.
- `src/settings.ts` — **`LifeLabsPdfSettings`** `{ timeZone }`, default
  `America/Toronto`: the report prints local clock times with no zone, and
  FHIR's `dateTime`-with-time / `instant` need one. The zone rides from
  `decode` to `parse` on the response header because `parse` sees the response,
  not the settings.
- `src/test-helpers.ts` (`./test-helpers` subpath) — `layoutReport` /
  `layoutDocument`, the print's inverse: a `LifeLabsReport` laid out as
  positioned text at the real column x's, header labels and footer. The
  dialect is pinned as `parseReports ∘ layoutReport = id` over
  `report-arbitrary.ts`'s generated reports.

## Layering

Depends on `positioned-text` (the positioned-text schema — the neutral seam
between the anonymizer's extraction and this dialect) and `kitchen-sink`
(`numRunsFor` in tests). Never imports `fhir-r4`, `har-importer-core`,
`pdf-anonymizer-core`, a `*-importer-react`, or `slices/collector`.

## Guardrails

- **The dialect interprets nothing.** A `ReportRow.result` is the printed
  string; deciding it is a quantity is the FHIR synthesis layer's job (added
  in the follow-up). Keep that split — it is what makes the round-trip
  property possible.
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
