# AGENTS.md — slices/anonymizer/pdf-anonymizer-react

The **PDF panel** of the anonymizer slice: the panel a host mounts over a
`PositionedTextDocument` (extracted from a PDF by `positioned-text-web`'s
`extractPositionedText`) to enter literal-substring substitution rules, preview
the masked runs, and download anonymized positioned-text JSON. Extraction runs
through the shared `positioned-text-web` seam; everything downstream is tested
on hand-written fixture documents.

## Shape

- **The pdfjs extraction seam moved to `positioned-text-web`**
  (`extractPositionedText`, in `slices/file-formats`); `pdfDescriptor` imports
  it from there. See
  [positioned-text-web](../../file-formats/positioned-text-web/AGENTS.md).
- `src/descriptor.ts` — **`pdfDescriptor`**: the
  `AnonymizerFormatDescriptor<PositionedTextDocument>` binding for PDF.
  Detects by `%PDF-` magic bytes; decodes via the extraction seam.
- `src/pdf-anonymize-panel.tsx` — **`PdfAnonymizePanel`**: the surface.
  Input is `{ value: PositionedTextDocument, fileName: string }`. Composes
  the rules editor, runs view, and download button.
- `src/rules-editor.tsx` — **`RulesEditor`**: TextField rows with live
  per-rule match counts; zero-match warning via `StatusBadge`.
- `src/runs-view.tsx` — **`RunsView`**: per-page container from page aspect
  ratio, absolutely positioned spans. Interactive: click a run to add it as
  a rule, hover for a glow, hover on a masked run to reveal the original.
  Inline style only for geometry values; tundraish tokens for everything else.
- `src/suggestions.tsx` — **`Suggestions`**: dual-action chips for
  frequently occurring text — anonymize (adds a rule) or dismiss (hides
  the suggestion to make room for more).
- `src/download-json.ts` — **`downloadBlob`** + **`positionedTextBlob`**:
  same-origin blob download pattern duplicated from
  `har-anonymizer-react/src/download-har.ts`.

## Layering

An adapter. Depends on `pdf-anonymizer-core` (the substitution engine +
file-name helper), `positioned-text` (the schema), `positioned-text-web` (the
pdfjs extraction seam), `anonymizer-fundamentals` (the descriptor contract),
`effect`, `react`, `react-kitchen-sink`, `react-tundraish`. No longer depends on
`pdfjs-dist` directly — that reaches it through `positioned-text-web`. Never
imports `har-anonymizer-core`, `har-anonymizer-react`, `importer-react`, or a
FHIR client.

## Traps

- **The extraction seam is untested — and now lives in `positioned-text-web`.**
  Everything downstream is tested on hand-written fixture documents; the seam
  only has to produce the same `PositionedTextDocument` shape.
- **The substitution is the core's output, not a second implementation.** The
  panel calls `applySubstitutions` from `pdf-anonymizer-core` and hands both
  the original and the anonymized documents to the runs view.
- **The download is a blob from the app's own origin, and nothing is uploaded.**
- **A source file name is not assumed to be path-safe.** `anonymizedJsonFileName`
  strips the trailing `.pdf` and sanitises the stem.

## Testing

- `pdf-anonymize-panel.test.tsx` — end-to-end panel tests: page/run counts,
  masking in downloaded JSON, live match counts, zero-match warning, add/remove
  rules, always-anonymized preview, click-to-add from preview, suggestion
  anonymize/dismiss, valid `PositionedTextDocument` in the download. Uses the
  blob-capture test harness from `har-anonymizer-react`.
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
