# AGENTS.md — slices/importer/lifelabs-pdf-importer-core

The **LifeLabs PDF binding** of the importer slice: the concrete
`FileImporterDescriptor` for format `'lifelabs-pdf'`. A LifeLabs patient
"Reports" PDF, extracted to the `wildflower-positioned-text` document the PDF
anonymizer (`slices/anonymizer/pdf-anonymizer-*`) produces and downloads, goes
in; `Patient` / `Practitioner` / `DiagnosticReport` / `Observation` resources
come out, behind the descriptor's opt-in `persist`. No DOM, no `fs`, no React.

The format's contents are a _document_, not HTTP traffic, so — per the
[Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
— the decode is a pure dialect here, wrapped by one `HttpResponseKind` whose
`tryRecognize` keys the document under a minted source identity. Nothing in
`slices/http-extraction` knows this format exists.

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
- `src/fhir/` — **the FHIR R4 synthesis**. `to-fhir.ts` is `toFhirResources`:
  one `Patient` per patient the reports name (keyed by `Patient ID`, else the
  health card digits, else name + date of birth), one `Practitioner` per
  `Ordered by` / `Copy To` name, one `DiagnosticReport` per report (LOINC
  11502-2, category `LAB`, the sections as `code.text`, `result` listing every
  observation, the lab licence + address as display-only `performer`), and one
  `Observation` per grid row (numeric results as `valueQuantity` with the
  comparator a censored `<0.1` carries, anything else as `valueString`; `HI` /
  `LO` as v3 interpretation `H` / `L`; the printed range as `referenceRange`
  low/high + text; the row's comments as one `note`). Every source id is a
  16-hex-digit digest of the report facts that determine it (`sourceId`), so
  a re-import lands on the same records and every id is a FHIR `id` the
  adoption's reference rewrite recognizes. `dates.ts` reads the printed
  `Mon D YYYY HH:MM` clock in a named zone (see settings); `reference-range.ts`
  and `result-value.ts` read the two grid columns.
- `src/response-kind.ts` — **`LifeLabsReportResponseKind`**, the one kind:
  `recognizePortal` on the URL `decode` mints, `parse` = decode the body as a
  positioned-text document → `parseReports` → `toFhirResources`, in the zone
  the `x-wildflower-time-zone` header names. `lifeLabsPdfResponseKinds` is it
  mapped through `adoptUnderRecognizedRoot`, keyed under `LIFELABS_SYSTEM`.
- `src/source.ts` — **`lifeLabsPdfSource`**, the `SourceDescriptor` the
  descriptor lists.
- `src/decode.ts` — **`decodeLifeLabsPdf`**: gate the file text through
  `PositionedTextFromJson`, then present it verbatim as one `Extraction.Input`
  under `https://wildflowerhealth.io/import/lifelabs-pdf/<fileName>` with the
  time-zone setting on a header. Requires nothing, writes nothing.
- `src/settings.ts` — **`LifeLabsPdfSettings`** `{ timeZone }`, default
  `America/Toronto`: the report prints local clock times with no zone, and
  FHIR's `dateTime`-with-time / `instant` need one. The zone rides from
  `decode` to `parse` on the response header because `parse` sees the response,
  not the settings.
- `src/persist-fhir.ts` — **`persistFhir`**, `withMetaSource` +
  `fhir-r4`'s `persistResources`; the same sink the HAR binding wraps,
  restated so the two bindings stay siblings.
- `src/source-system.ts` — `LIFELABS_SYSTEM` (**persisted wire format** — the
  hash domain of every local id) and `LifeLabsIdentifierSystem` (lab number,
  patient id, Ontario health card number).
- `src/test-helpers.ts` (`./test-helpers` subpath) — `layoutReport` /
  `layoutDocument`, the print's inverse: a `LifeLabsReport` laid out as
  positioned text at the real column x's, header labels and footer. The
  dialect is pinned as `parseReports ∘ layoutReport = id` over
  `report-arbitrary.ts`'s generated reports.

## Layering

Depends on `pdf-anonymizer-core` (the positioned-text schema — the neutral
seam between the anonymizer's extraction and this dialect), `importer-fundamentals`
(the contract), `http-extraction-fundamentals` (`Extraction.Input`,
`HttpResponseKind`, `recognizePortal`, `SourceDescriptor`), `fhir-r4`
(resources, `identity`, `persistResources`), `web-trace-core/provenance`
(`withMetaSource`), `kitchen-sink` (`fnv1a64`), and `effect`. Never imports
`har-importer-core`, a `*-importer-react`, or `slices/collector`.

## Guardrails

- **The read half never writes.** `decode` and every `parse` require no
  services; writing is `persistFhir` behind the descriptor's `persist`.
- **The dialect interprets nothing; the synthesis interprets everything.** A
  `ReportRow.result` is the printed string; `to-fhir.ts` decides it is a
  quantity. Keep that split — it is what makes the round-trip property possible.
- **Every grid row is an Observation**, `Collection Date` and
  `Reference Interval Note` included: each is a line the report prints, and
  deciding some are metadata would drop them silently.
- **No LOINC guessing.** `Observation.code` is the printed test name as `text`;
  a LOINC map is a separate, reviewed change.
- **No `Organization`, no `ServiceRequest`.** The store carries neither, so the
  laboratory is a display-only `performer` and the ordering provider is linked
  as the patient's `generalPractitioner`; `Copy To` practitioners are imported
  standalone.
- **A masked field is absent, not invented.** The anonymizer's `Xxx 00 0000`
  reads as no date of birth; a masked lab number that repeats is told apart by
  the page footer and the date of service (which is why a report's source id
  folds both).

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [Adding a File-Format Importer How-To](../docs/Adding%20a%20File-Format%20Importer%20How-To.md)
  — the recipe this binding follows for a document format.
- [pdf-anonymizer-core AGENTS.md](../../anonymizer/pdf-anonymizer-core/AGENTS.md)
  — the positioned-text schema.
- [lifelabs-pdf-importer-react AGENTS.md](../lifelabs-pdf-importer-react/AGENTS.md)
  — the format's settings picker and review.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why every resource is re-keyed under a derived local id.
