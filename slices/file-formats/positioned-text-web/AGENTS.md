# AGENTS.md — slices/file-formats/positioned-text-web

The browser (non-React) **extraction seam** of the `file-formats` slice:
`extractPositionedText` turns a PDF's raw bytes into a `Document.Type`
via a dynamically imported `pdfjs-dist`. The PDF anonymizer calls it directly;
the importer's host provides `positionedTextExtractorPdfjs`, the
`PositionedTextExtractor` layer built on it. Both feed off this one seam rather
than integrating pdfjs twice.

It is a `-web` adapter, not `-react`: nothing here touches React. The (deferred)
positioned-text preview viewer is React and would land as a separate
`positioned-text-react`.

## Shape

- `src/extract-pdf.ts` — **`extractPositionedText(bytes, fileName?)`**: the
  pdfjs-dist seam. The dynamic `import('pdfjs-dist')` keeps the ~2 MB library
  off the critical path; the worker is configured via
  `GlobalWorkerOptions.workerSrc` with an `import.meta.url`-relative path so a
  bundling host emits the worker asset alongside its bundle.
- `src/positioned-text-extractor-pdfjs.ts` — **`positionedTextExtractorPdfjs`**,
  the `Layer` that provides `positioned-text`'s `PositionedTextExtractor` with
  `extractPositionedText`, a rejection becoming `UnreadablePdf`.
  `importer-react` provides it where it runs `readBatch` and `redecodeFormat`.
- `src/index.ts` — the package barrel.

## Layering

Depends on `positioned-text` (the schema it produces and the service it
provides), `pdfjs-dist` (extraction) and `effect` (the layer). No React.
`platform: 'neutral'`.

## Traps

- **The extraction seam is untested — deliberately.** Everything downstream is
  tested on hand-written fixture `Document`s; the seam only has to
  produce that shape. Keep it under ~60 lines and free of logic worth testing.
  A test that runs a PDF decode provides a fake `PositionedTextExtractor`
  instead of this layer, never a `vi.mock` of this package.

## References

- [slices/file-formats AGENTS.md](../AGENTS.md) — the slice's role and layering.
- [positioned-text AGENTS.md](../positioned-text/AGENTS.md) — the schema this
  seam fills.
- [pdf-anonymizer-react AGENTS.md](../../../slices/anonymizer/pdf-anonymizer-react/AGENTS.md)
  — the panel whose descriptor calls this seam.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
