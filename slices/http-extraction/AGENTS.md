# AGENTS.md — slices/http-extraction

The abstract fundamentals of **extracting entities from HTTP traffic**, plus
per-source implementations. The `importer` slice's HAR importer runs the
vocabulary **over archives** (each archived response recognized and decoded
through `Extraction.recognize` / `parseWith`), and the synthetic-data
generators spell the HARs it imports from the source packages' wire schemas and
URLs; neither owns this slice. Nothing here knows about sniffers, navigation,
persistence, HAR, files, or apps.

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
- **`fhir-r4-adoption`** — the FHIR R4 side of extraction, above `fhir-r4`
  and `http-extraction-fundamentals`, which stays FHIR-free: how a resource
  decoded from a source becomes the device's own, adopted under the source's
  identity with an id whether or not the source gave it one (`DecodedId`).
  `adoptUnderRecognizedRoot` adopts every resource a response kind parses under
  the identity its `tryRecognize` mints; each per-source package maps its kinds
  through it. See its [AGENTS.md](./fhir-r4-adoption/AGENTS.md).
- **`fhir-r4-source`** — the first per-source package: `fhirR4Source`, a
  `SourceDescriptor` whose `responseKinds` are the FHIR R4 kinds pre-adopted so
  each resource keys in `<root>/<Type>` of the URL it arrived on — the single
  definition an archive import consumes. See its
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

## There is deliberately no `http-extraction-core`

A consumer assembles its **own** closed list from the per-source packages,
shaped for what it does with it: the HAR importer needs a flat pool of response
kinds every response is routed against by highest specificity
(`har-importer-core`'s `fhirPool`). A shared registry would fix one consumer's
members and payload for every consumer. Add a `-core` only if a genuine shared
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

- **This slice imports from no slice but the resource and dialect packages it
  decodes with.** `http-extraction-fundamentals` depends only on `effect` and
  `kitchen-sink`; `fhir-r4-adoption` adds `fhir-r4`, and a source package adds
  `fhir-r4-adoption` and the resource/dialect packages it decodes with
  (`fhir-r4-source` → `fhir-r4`). Never `importer-*`.

## References

- [http-extraction-fundamentals AGENTS.md](./http-extraction-fundamentals/AGENTS.md)
  — the vocabulary and its namespaces.
- [fhir-r4-source AGENTS.md](./fhir-r4-source/AGENTS.md) — the worked example
  source package.
- [slices/importer/AGENTS.md](../importer/AGENTS.md) — the archive-driven
  consumer.
- [Source Identity Explanation](./fhir-r4-adoption/docs/Source%20Identity%20Explanation.md)
  — the identity each source package's response kinds key resources under.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
