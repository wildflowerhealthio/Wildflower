# AGENTS.md — slices/file-formats/http-archive

The **HTTP Archive format** (HAR 1.2), as one schema read in both directions —
the neutral decode seam below both the importer (which parses an archive into
FHIR) and the anonymizer (which redacts one). No DOM, no `fs`, no React.

Moved out of `har-importer-core/har` (the old `/har` subpath) into the
`file-formats` slice so both consumers depend **down** into it, rather than the
anonymizer reaching sideways into the importer.

## Shape

- `src/har.ts` — **the HAR 1.2 format** (`Har`, `HarFromJson`, `HarEntry`,
  `HarResponse`, `HarBody` and friends, `NOT_MEASURED`), held to the published
  spec by `har-schema` compiled through `ajv`.
- `src/emit.ts` — **`emitHar` / `emitHarFromLog`**: build an archive from
  captured `TraceExchange`es, plus the comment constants that annotate what an
  import did not carry through (`DROPPED_REQUEST_ON_IMPORT_COMMENT`, etc.).
- `src/http-archive.ts` — the **`HttpArchive`** projection an importer and a
  replay consume (`Entry`, `Log`, `LogFromHarJson`): the response half of each
  archived exchange, a schema in both directions.
- `src/index.ts` — re-exports the three modules; the package root is what was
  the `har-importer-core/har` subpath.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect`,
`browser-sniffer-core` (`HeadersWire`), `http-extraction-fundamentals`
(`HarMethodValueSchema`, `isHttpMethod`), and — transitionally, until #578
dissolves `slices/web-trace` — `web-trace-core` (`TraceExchange`,
`contentTypeOf`, `noTimings`). `ajv` + `har-schema` are bundled. Never imports
`har-importer-core`, any `*-anonymizer-*`, a React package, or `fhir-r4`.

## Testing

- `http-archive.test.ts` — the projection round-trips through
  `LogFromHarJson`; a foreign archive decodes to the response half it observed.
- `emit.test.ts` — an emitted archive validates against the HAR spec and
  round-trips the exchanges it was built from.

## References

- [slices/file-formats AGENTS.md](../AGENTS.md) — the slice's role and layering.
- [har-importer-core AGENTS.md](../../importer/har-importer-core/AGENTS.md) — the
  importer binding that decodes through `HttpArchive.LogFromHarJson`.
- [har-anonymizer-core AGENTS.md](../../anonymizer/har-anonymizer-core/AGENTS.md)
  — the redactor that walks an `HttpArchive.Log`.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the
  `TraceExchange` vocabulary this format is built on (slated for dissolution).
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
