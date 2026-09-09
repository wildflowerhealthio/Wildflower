# AGENTS.md — slices/anonymizer/pdf-anonymizer-react

The **PDF panel** of the anonymizer slice: the panel a host mounts over a
`PositionedTextDocument` (extracted from a PDF via pdfjs-dist) to enter
literal-substring substitution rules, preview the masked runs, and download
anonymized positioned-text JSON. Uses pdfjs-dist for extraction behind a seam;
everything downstream is tested on hand-written fixture documents.

## Shape

- `src/extract-pdf.ts` — the **pdfjs-dist seam**: dynamic
  `import('pdfjs-dist')` inside the function, worker configured via
  `GlobalWorkerOptions.workerSrc`. Stays under ~60 lines and untested;
  everything downstream is tested on fixture documents.
- `src/descriptor.ts` — **`pdfDescriptor`**: the
  `AnonymizerFormatDescriptor<PositionedTextDocument>` binding for PDF.
  Detects by `%PDF-` magic bytes; decodes via the extraction seam.
- `src/pdf-anonymize-panel.tsx` — **`PdfAnonymizePanel`**: the surface.
  Input is `{ value: PositionedTextDocument, fileName: string }`. Composes
  the rules editor, runs view, and download button.
- `src/rules-editor.tsx` — **`RulesEditor`**: TextField rows with live
  per-rule match counts; zero-match warning via `StatusBadge`.
- `src/runs-view.tsx` — **`RunsView`**: per-page container from page aspect
  ratio, absolutely positioned spans. Inline style only for geometry values;
  tundraish tokens for everything else.
- `src/download-json.ts` — **`downloadBlob`** + **`positionedTextBlob`**:
  same-origin blob download pattern duplicated from
  `har-anonymizer-react/src/download-har.ts`.

## Layering

An adapter. Depends on `pdf-anonymizer-core` (the schema and substitution
engine), `anonymizer-fundamentals` (the descriptor contract),
`pdfjs-dist` (extraction), `effect`, `react`, `react-kitchen-sink`,
`react-tundraish`. Never imports `har-anonymizer-core`,
`har-anonymizer-react`, `importer-react`, or a FHIR client.

## Traps

- **The extraction seam is untested.** Everything downstream is tested on
  hand-written fixture documents — the seam produces the same
  `PositionedTextDocument` shape.
- **The substitution is the core's output, not a second implementation.** The
  panel calls `applySubstitutions` from `pdf-anonymizer-core` and hands both
  the original and the anonymized documents to the runs view.
- **The download is a blob from the app's own origin, and nothing is uploaded.**
- **A source file name is not assumed to be path-safe.** `anonymizedJsonFileName`
  strips the trailing `.pdf` and sanitises the stem.

## Testing

- `pdf-anonymize-panel.test.tsx` — end-to-end panel tests: page/run counts,
  masking in downloaded JSON, live match counts, zero-match warning, add/remove
  rules, toggle between original and anonymized preview, valid
  `PositionedTextDocument` in the download. Uses the blob-capture test harness
  from `har-anonymizer-react`.
- `download-json.test.ts` — blob round-trip through `PositionedTextFromJson`,
  anchor click, file-name conventions.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [pdf-anonymizer-core AGENTS.md](../pdf-anonymizer-core/AGENTS.md) — the
  schema and substitution engine.
- [har-anonymizer-react AGENTS.md](../har-anonymizer-react/AGENTS.md) — the
  HAR panel this one mirrors.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
