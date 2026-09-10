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

The deferred positioned-text preview viewer (React `RunsView`) would join as a
`positioned-text-react` when it is extracted from `pdf-anonymizer-react`.

## Layering

- **Cores here are pure** — no DOM, no `fs`, no platform imports
  (`platform: 'neutral'`). Browser-only pieces live in an adapter:
  `positioned-text-web` carries the `pdfjs-dist` extraction seam (a `-web`, not
  `-react`, package — it touches no React).
- **Consumers depend down.** Nothing in this slice imports `slices/importer`,
  `slices/anonymizer`, or a React package.

## References

- [slices/importer AGENTS.md](../importer/AGENTS.md) — the parse-side consumer.
- [slices/anonymizer AGENTS.md](../anonymizer/AGENTS.md) — the redact-side
  consumer whose sibling shape this slice sits beneath.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
