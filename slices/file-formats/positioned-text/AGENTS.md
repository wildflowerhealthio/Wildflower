# AGENTS.md — slices/file-formats/positioned-text

A PDF's text content as absolutely positioned runs — the neutral decode seam
below both the importer (a dialect parses it into records) and the anonymizer
(it masks the runs and downloads them). No DOM, no `fs`, no React, no extraction
library.

Moved out of `pdf-anonymizer-core` into the `file-formats` slice so the
LifeLabs importer dialect could consume the schema without depending on the
anonymizer.

## Shape

A schema per file, each re-exported as a namespace from `src/index.ts`
(`export * as Document`, `export * as Page`, `export * as Run`) so consumers
read `Document.Schema` / `Document.Type`, `Page.Schema`, `Run.Schema`:

- `src/document.ts` — **`Document.Schema`** Effect Schema
  (`{ format: 'wildflower-positioned-text', version: 1, fileName?, pages:
[{ pageNumber, width, height, runs: [{ text, x, y, width, fontSize,
fontName? }] }] }`, top-left `y` origin), plus **`Document.FromJson`**
  (`Schema.parseJson`) for round-tripping through JSON.
- `src/page.ts` — **`Page.Schema`**, one page of positioned runs.
- `src/run.ts` — **`Run.Schema`**, one positioned span of text.
- `src/index.ts` — the package barrel.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends only on `effect`. Names no UI
framework and no extraction library — the pdfjs seam that fills this schema
lives in `positioned-text-web`. Never imports `pdf-anonymizer-*`,
`lifelabs-pdf-importer-core`, or a DOM type.

## Testing

- `positioned-text.test.ts` — the schema accepts/rejects the right shapes, and
  a document round-trips through `Document.FromJson`.

## References

- [slices/file-formats AGENTS.md](../AGENTS.md) — the slice's role and layering.
- [positioned-text-web AGENTS.md](../positioned-text-web/AGENTS.md) — the pdfjs
  extraction seam that produces this schema.
- [pdf-anonymizer-core AGENTS.md](../../anonymizer/pdf-anonymizer-core/AGENTS.md)
  — the masking engine that consumes it.
- [lifelabs-pdf-importer-core AGENTS.md](../../importer/lifelabs-pdf-importer-core/AGENTS.md)
  — the dialect that parses it.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
