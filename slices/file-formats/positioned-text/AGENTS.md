# AGENTS.md — slices/file-formats/positioned-text

A PDF's text content as absolutely positioned runs — the neutral decode seam
below both the importer (a dialect parses it into records) and the anonymizer
(it masks the runs and downloads them). No DOM, no `fs`, no React, no extraction
library.

## Shape

A schema per file, each re-exported as a namespace from `src/index.ts`
(`export * as Document`, `export * as Page`, `export * as Run`) so consumers
read `Document.Schema` / `Document.Type`, `Page.Schema`, `Run.Schema`:

- `src/document.ts` — **`Document.Schema`** Effect Schema
  (`{ format: 'wildflower-positioned-text', version: 1, fileName?, pages:
  [{ pageNumber, width, height, runs: [{ text, x, y, width, fontSize,
  fontName? }] }] }`, top-left `y` origin, every measure finite and
  `pageNumber` whole), plus **`Document.FromJson`** (`Schema.parseJson`) for
  round-tripping through JSON, **`Document.mapText`**, and **`Document.runs`**
  (every run, flattened in page then run order).
- `src/page.ts` — **`Page.Schema`**, one page of positioned runs, and
  **`Page.mapText`**.
- `src/run.ts` — **`Run.Schema`**, one positioned span of text, and
  **`Run.mapText`**.
- `src/index.ts` — the package barrel.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends only on `effect`. Names no UI
framework and no extraction library — the pdfjs seam that fills this schema
lives in `positioned-text-web`. Never imports `pdf-anonymizer-*`,
`lifelabs-pdf-importer`, or a DOM type.

## Testing

- `positioned-text.test.ts` — the schema accepts/rejects the right shapes
  (including non-finite measures), a document round-trips through
  `Document.FromJson`, `mapText` rewrites only run text, and `Document.runs`
  keeps page then run order.

## References

- [slices/file-formats AGENTS.md](../AGENTS.md) — the slice's role and layering.
- [positioned-text-web AGENTS.md](../positioned-text-web/AGENTS.md) — the pdfjs
  extraction seam that produces this schema.
- [pdf-anonymizer-core AGENTS.md](../../../slices/anonymizer/pdf-anonymizer-core/AGENTS.md)
  — the masking engine that consumes it.
- [lifelabs-pdf-importer AGENTS.md](../../importer/lifelabs-pdf-importer/AGENTS.md)
  — the dialect that parses it.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
