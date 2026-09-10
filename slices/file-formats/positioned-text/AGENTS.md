# AGENTS.md — slices/file-formats/positioned-text

A PDF's text content as absolutely positioned runs — the neutral decode seam
below both the importer (a dialect parses it into records) and the anonymizer
(it masks the runs and downloads them). No DOM, no `fs`, no React, no extraction
library.

Moved out of `pdf-anonymizer-core` into the `file-formats` slice so the
LifeLabs importer dialect could consume the schema without depending on the
anonymizer.

## Shape

- `src/positioned-text.ts` — **`PositionedTextDocument`** Effect Schema
  (`{ format: 'wildflower-positioned-text', version: 1, fileName?, pages:
[{ pageNumber, width, height, runs: [{ text, x, y, width, fontSize,
fontName? }] }] }`, top-left `y` origin), plus `PositionedTextPage` /
  `PositionedTextRun` and **`PositionedTextFromJson`** (`Schema.parseJson`) for
  round-tripping through JSON.
- `src/index.ts` — the package barrel.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends only on `effect`. Names no UI
framework and no extraction library — the pdfjs seam that fills this schema
lives in `positioned-text-web`. Never imports `pdf-anonymizer-*`,
`lifelabs-pdf-importer-core`, or a DOM type.

## Testing

- `positioned-text.test.ts` — the schema accepts/rejects the right shapes, and
  a document round-trips through `PositionedTextFromJson`.

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
