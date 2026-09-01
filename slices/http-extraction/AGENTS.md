# AGENTS.md — slices/http-extraction

The abstract fundamentals of **extracting entities from HTTP traffic**, plus
per-source implementations. Two consumers build on this slice and neither owns
it: the `collector` slice runs the vocabulary **live** (a sniffer webview
streams responses through the same entities), and the `importer` slice's HAR
importer runs it **over archives** (each archived response recognized and
decoded through `Extraction.recognize` / `parseWith`). Nothing here knows about sniffers,
navigation, persistence, HAR, files, or apps.

## Packages

- **`http-extraction-fundamentals`** — the vocabulary, as `effect`-style
  namespaces from one flat entry: `HttpResponseKind` / `UrlMatch` /
  `HttpResponse` (how one response is recognized and decoded into resources),
  `Extraction` (`routeTo` / `recognize` / `parseWith` over
  archived responses), and `Specificity` (the cross-source tier constants
  routing ranks a claim by). A response kind carries its own recognition +
  identity on `tryRecognize(url)`; there is no separate `Source` value. Imports
  from no slice. See its
  [AGENTS.md](./http-extraction-fundamentals/AGENTS.md).
- **`fhir-r4-source`** — the first per-source package: `fhirR4ResponseKinds`,
  the FHIR R4 response kinds pre-adopted so each resource keys under the root
  of the URL it arrived on, the single definition both a live plan and an
  archive import consume. See its
  [AGENTS.md](./fhir-r4-source/AGENTS.md). The rexall and shoppers entities
  still live inside their collector packages (they already build on the
  fundamentals here); extracting them into sibling `*-source` packages is
  planned follow-up work, one PR each.

## There is deliberately no `http-extraction-core`

Each consumer assembles its **own** closed list from the per-source packages,
because the two lists have different members and different payloads: the HAR
importer needs a flat pool of response kinds every response is routed against by
highest specificity (`har-importer-core`'s `fhirPool`); the collector needs a
descriptor tuple carrying config schemas, forms, plans, and persist sinks
(`collector-registry`'s `descriptors`). A shared registry would force one of
those concerns into the other's home. Add a `-core` only if a genuine shared
enumeration need appears.

## Future formats don't come through here

A CSV or DICOM import is a _document_, not HTTP traffic — its decode belongs
in a pure dialect package (the way rexall's carebook dialect and
`web-trace-core`'s codec already work), which a file importer wraps in the
importer slice. This slice only enters that picture if the same source is
_also_ reachable over HTTP: then an `HttpResponseKind.parse` wraps the same
dialect from `response.bytes()`, and the dialect sits below both transports —
which is exactly what keeps the dependency graph acyclic.

## Guardrails

- **This slice imports from no other slice.** `http-extraction-fundamentals`
  depends only on `effect` and `kitchen-sink`; a source package adds only the
  resource/dialect packages it decodes with (`fhir-r4-source` → `fhir-r4`).
  Never `collector-*`, never `importer-*`.
- **The live-vs-archive parity pin lives in `collector-fundamentals`**
  (`src/handler/extraction-parity.test.ts`) — the one package that can see
  both `runExtraction` (the archive-runner reference model in
  `http-extraction-fundamentals`' test-helpers) and the live tracker. A test
  here that wants `CollectorHttpResponse` is in the wrong package.
- **A source's per-source parity test lives with the collector config it
  needs** (`fhir-r4-client-collector/src/source-parity.test.ts`), because the
  dependency points from the collector to the source package, never back.

## References

- [http-extraction-fundamentals AGENTS.md](./http-extraction-fundamentals/AGENTS.md)
  — the vocabulary and its namespaces.
- [fhir-r4-source AGENTS.md](./fhir-r4-source/AGENTS.md) — the worked example
  source package.
- [slices/collector/AGENTS.md](../collector/AGENTS.md) — the live consumer.
- [slices/importer/AGENTS.md](../importer/AGENTS.md) — the archive-driven
  consumer.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
