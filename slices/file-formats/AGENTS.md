# AGENTS.md — slices/file-formats

The **neutral decode seams** for the files a user picks: the format schemas that
sit **below** both the importer (which parses a decoded file into FHIR) and the
anonymizer (which redacts one). Neither of those slices owns a format; each
depends _down_ into this one, which is what keeps the graph acyclic — before
this slice existed, the anonymizer reached sideways into `har-importer-core` for
the HAR seam.

A package here owns a decoded representation, not the bytes and not the
interpretation: it decodes/encodes and validates a format, and stops there.
Masking (anonymizer) and dialect parsing (importer bindings) live in the
consumer slices.

## Package roles

- **[`http-archive`](./http-archive/AGENTS.md)** — the HTTP Archive format
  (HAR 1.2): `Har`/`HarFromJson`, `emitHar`/`emitHarFromLog`, and the
  `HttpArchive` projection an importer and a replay consume. Moved out of the
  old `har-importer-core/har` subpath.
- **[`positioned-text`](./positioned-text/AGENTS.md)** — a PDF's text content
  as absolutely positioned runs: the `Document.Schema` schema
  (`wildflower-positioned-text` v1) and `Document.FromJson`. Moved out of
  `pdf-anonymizer-core`. `effect` only.
- **[`positioned-text-web`](./positioned-text-web/AGENTS.md)** — the browser
  (non-React) `extractPositionedText` seam that fills the schema from PDF bytes
  via `pdfjs-dist`. Moved out of `pdf-anonymizer-react`. The one place PDF
  extraction is integrated, shared by the anonymizer and a future PDF importer.
- **`dicom`** — pure DICOM Part 10 tag reader: `parseDicomFile` wraps
  `dicom-parser` into a typed `DicomHeader` of the tags the importer cares
  about (patient, study, series, instance, equipment modules) plus the Image
  Pixel module and a `PixelDataDescription` of the (7FE0,0010) element — the
  decode-debug half, which nothing in the FHIR synthesis reads and a preview
  needs to explain why a viewer showed nothing. `transferSyntaxName` /
  `sopClassName` name a UID for display; they derive from a UID rather than
  reading a tag, so they are functions beside the header, not fields in it.
  `effect` + `dicom-parser` only. The `test-helpers` subpath exports
  `writeDicom` (a minimal explicit-VR little-endian writer, which also emits
  native or encapsulated Pixel Data) and fast-check arbitraries for
  synthesizing DICOM fixtures in tests.
- **[`dicom-react`](./dicom-react/AGENTS.md)** — browser-side DICOM rendering:
  `DicomArchivePreview` (identifying patient and study tags, plus an Encoding
  block, beside a cornerstone-rendered image pane) and the `renderInstance`
  seam. Depends on `dicom` for tag parsing, `@cornerstonejs/core` and
  `@cornerstonejs/dicom-image-loader` for image rendering. The `-react` adapter
  for the `dicom` parser, consumed by `dicom-importer-react`.

The deferred positioned-text preview viewer (React `RunsView`) would join as a
`positioned-text-react` when it is extracted from `pdf-anonymizer-react`.

## Layering

- **Cores here are pure** — no DOM, no `fs`, no platform imports
  (`platform: 'neutral'`). Browser-only pieces live in an adapter:
  `positioned-text-web` carries the `pdfjs-dist` extraction seam (a `-web`, not
  `-react`, package — it touches no React); `dicom-react` carries the
  cornerstone rendering adapter (a `-react` package — it depends on React and
  on `@cornerstonejs/*`, but not on any importer slice).
- **Consumers depend down.** Nothing in this slice imports `slices/importer`
  or `slices/anonymizer`.

## References

- [Cornerstone Rendering Explanation](./docs/Cornerstone%20Rendering%20Explanation.md) —
  why `dicom-react`'s image pane needs a resize observer, which transfer
  syntaxes decode where, and what a host app's build must configure.
- [slices/importer AGENTS.md](../importer/AGENTS.md) — the parse-side consumer.
- [slices/anonymizer AGENTS.md](../anonymizer/AGENTS.md) — the redact-side
  consumer whose sibling shape this slice sits beneath.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
