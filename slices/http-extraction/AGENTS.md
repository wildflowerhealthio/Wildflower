# AGENTS.md — slices/http-extraction

The abstract fundamentals of **extracting entities from HTTP traffic**, plus
per-source implementations. Two consumers build on this slice and neither owns
it: the `collector` slice runs the vocabulary **live** (a sniffer webview
streams responses through the same entities; it lives with the launcher in
`apps/launcher/collector`), and the `importer` slice's HAR
importer runs it **over archives** (each archived response recognized and
decoded through `Extraction.recognize` / `parseWith`). Nothing here knows about sniffers,
navigation, persistence, HAR, files, or apps.

## Packages

- **`http-extraction-fundamentals`** — the vocabulary, as `effect`-style
  namespaces from one flat entry: `HttpResponseKind` / `UrlMatch` /
  `HttpResponse` (how one response is recognized and decoded into resources),
  `Extraction` (`routeTo` / `recognize` / `parseWith` over
  archived responses), `SourceDescriptor` ("a source package" as one value —
  name, display strings, kinds, and an optional merge for resources its kinds
  emit under one id), and `Specificity` (the cross-source tier constants
  routing ranks a claim by). A response kind carries its own recognition +
  identity on `tryRecognize(url)`; there is no separate recognition-carrying
  `Source` value (a `SourceDescriptor` recognizes nothing).
  Imports from no slice. See its
  [AGENTS.md](./http-extraction-fundamentals/AGENTS.md).
- **`fhir-r4-source`** — the first per-source package: `fhirR4Source`, a
  `SourceDescriptor` whose `responseKinds` are the FHIR R4 kinds pre-adopted so
  each resource keys under the root of the URL it arrived on — the single
  definition both a live plan and an archive import consume. See its
  [AGENTS.md](./fhir-r4-source/AGENTS.md).
- **`rexall-be-well-source`** — the Rexall Be Well source: three response kinds
  (Patient, MedicationRequest, MedicationDispense) that decode Rexall's carebook
  STU3 dialect into FHIR R4 resources, plus that dialect's catalogue, wire
  schemas and tunnel URLs for a producer of carebook traffic to spell it from.
  See its [AGENTS.md](./rexall-be-well-source/AGENTS.md).
- **`shoppers-drugmart-source`** — the Shoppers Drug Mart source: three response
  kinds (Customer, Prescription, PrescriptionHistory) that synthesize FHIR R4
  Patient / MedicationRequest / MedicationDispense from the portal's bespoke
  JSON, plus that JSON's schemas, API URLs and identifier catalogue for a
  producer of portal traffic to spell it from. See its
  [AGENTS.md](./shoppers-drugmart-source/AGENTS.md).

`web-trace-source`, the catch-all recording entity and capture-time body
policy, is written against this vocabulary too, but lives beside its one
consumer in
[`apps/launcher/collector/`](../../apps/launcher/collector/web-trace-source/AGENTS.md).

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
- [web-trace-source AGENTS.md](../../apps/launcher/collector/web-trace-source/AGENTS.md)
  — the catch-all recording source package.
- [apps/launcher/collector/AGENTS.md](../../apps/launcher/collector/AGENTS.md) — the live consumer.
- [slices/importer/AGENTS.md](../importer/AGENTS.md) — the archive-driven
  consumer.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
