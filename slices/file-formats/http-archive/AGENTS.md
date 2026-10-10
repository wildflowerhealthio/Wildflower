# AGENTS.md — slices/file-formats/http-archive

The **HTTP Archive format** (HAR 1.2), as one schema read in both directions —
the neutral decode seam below both the importer (which parses an archive into
FHIR) and the anonymizer (which redacts one). No DOM, no `fs`, no React.

Moved out of `har-importer-core/har` (the old `/har` subpath) into the
`file-formats` slice so both consumers depend **down** into it, rather than the
anonymizer reaching sideways into the importer.

## Shape

- `src/har.ts` — **the HAR 1.2 format** (`Har`, `HarFromJson`, `HarLog`,
  `HarPage`, `HarEntry`, `HarResponse`, `HarTimings`, `HarBody` and friends,
  `NOT_MEASURED`), held to the published spec by `har-schema` compiled
  through `ajv`. Fields the spec requires default when absent (`-1` for an
  unmeasured number); fields it leaves optional (`pages`, `pageref`,
  `serverIPAddress`, `connection`, the `blocked`/`dns`/`connect`/`ssl`
  phases, `pageTimings`) stay optional. Unknown keys are ignored, so the
  `_`-prefixed vendor extras of a DevTools export are dropped on decode.
- `src/chrome-har.ts` — **`ChromeHar`**: the same format with the Chrome
  DevTools entry extras declared (`ChromeHarEntry` adds `_initiator`,
  `_priority`, `_resourceType`; `ChromeHarLog`, `ChromeHarFromJson`,
  `chromeHarToJson` / `chromeHarFromJson`), so a producer or reader of a
  Chrome-shaped archive keeps them. Kept off the base schemas because they are
  one browser's extension, not the format. A `ChromeHar` is structurally a
  `Har`; writing one through `harToJson` drops the extras. Also the
  vocabulary a producer of a DevTools-shaped archive writes with:
  `CHROME_CREATOR` (`WebInspector` `537.36`, as "Save all as HAR" names
  itself), the literal types `ChromeResourceType` (`document` | `xhr` |
  `fetch`), `ChromePriority` and `ChromeInitiatorType`, `chromeExtrasOf`
  (a resource type's `_initiator` / `_priority` / `_resourceType` as a
  `ChromeHarExtras`), `chromePageOf` (a `ChromePageSpec` as a `HarPage`
  titled with its URL) and `chromeHarOf` (pages and entries as a 1.2
  archive under `CHROME_CREATOR`). The schemas stay open strings, so an
  export carrying other values still reads.
- `src/emit.ts` — **`emitHar` / `emitHarFromLog`**: build an archive from
  captured `TraceExchange`es or from an `HttpArchive.Log`, plus the comment
  constants that annotate what an import did not carry through
  (`DROPPED_REQUEST_ON_IMPORT_COMMENT`, etc.). `emitHarFromLog` serves more
  than one producer, so `creatorName` and `requestComment` are options — the
  HAR recorder names itself and states that its request side was never
  observed, while the anonymizer takes the defaults (`CREATOR_NAME`,
  `DROPPED_REQUEST_ON_IMPORT_COMMENT`). Also `harToJson` / `harFromJson`
  (the `.har` file text; `{ pretty: true }` indents two spaces as DevTools
  does) and `queryStringOf` (a URL's parameters as `request.queryString`).
- `src/http-archive.ts` — the **`HttpArchive`** projection an importer and a
  replay consume (`Entry`, `Log`, `LogFromHarJson`): the response half of each
  archived exchange, a schema in both directions.
- `src/index.ts` — re-exports the four modules; the package root is what was
  the `har-importer-core/har` subpath.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect`,
`browser-sniffer-core` (`HeadersWire`), `http-extraction-fundamentals`
(`HarMethodValueSchema`, `isHttpMethod`), and — transitionally, until #578
dissolves it — `web-trace-core` (`TraceExchange`,
`contentTypeOf`, `noTimings`). `ajv` + `har-schema` are bundled. Never imports
`har-importer-core`, any `*-anonymizer-*`, a React package, or `fhir-r4`.

## Testing

- `http-archive.test.ts` — the projection round-trips through
  `LogFromHarJson`; a foreign archive decodes to the response half it observed.
- `emit.test.ts` — an emitted archive validates against the HAR spec and
  round-trips the exchanges it was built from; one carrying pages, `pageref`,
  `serverIPAddress` and every timing phase validates and round-trips too;
  `harToJson` writes compact or pretty text of the same archive.
- `chrome-har.test.ts` — a `ChromeHar` round-trips pages, `pageref` and the
  DevTools extras through its file text; an archive built with the producer
  vocabulary round-trips with its creator and extras, and `chromeExtrasOf`
  covers every `ChromeResourceType`; the base `Har` reads the same export
  with only the extras dropped.

## References

- [slices/file-formats AGENTS.md](../AGENTS.md) — the slice's role and layering.
- [har-importer-core AGENTS.md](../../importer/har-importer-core/AGENTS.md) — the
  importer binding that decodes through `HttpArchive.LogFromHarJson`.
- [har-anonymizer-core-js AGENTS.md](../../../apps/importer/anonymizer/har-anonymizer-core-js/AGENTS.md)
  — the redactor that walks an `HttpArchive.Log`.
- [web-trace-core AGENTS.md](../../web-trace-core/AGENTS.md) — the
  `TraceExchange` vocabulary this format is built on (slated for dissolution).
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
