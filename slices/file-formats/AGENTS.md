# AGENTS.md — slices/file-formats

The **neutral decode seams** for the files a user picks: the format schemas that
sit **below** both the importer (which parses a decoded file into FHIR) and the
anonymizer (which redacts one). Neither of those slices owns a format; each
depends *down* into this one, which is what keeps the graph acyclic — before
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

A `positioned-text` (the PDF anonymizer's `PositionedTextDocument` schema) is the
expected next sibling; it is not extracted yet.

## Layering

- **Cores here are pure** — no DOM, no `fs`, no platform imports
  (`platform: 'neutral'`). A future `*-react` adapter (e.g. a pdfjs extraction
  seam) would carry the browser-only pieces.
- **Consumers depend down.** Nothing in this slice imports `slices/importer`,
  `slices/anonymizer`, or a React package.

## References

- [slices/importer AGENTS.md](../importer/AGENTS.md) — the parse-side consumer.
- [slices/anonymizer AGENTS.md](../anonymizer/AGENTS.md) — the redact-side
  consumer whose sibling shape this slice sits beneath.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
