# AGENTS.md — slices/http-extraction/fhir-r4-source

The **FHIR R4 source**: the single definition of how FHIR R4 traffic decodes
into resources, exported as one `SourceDescriptor` value — `fhirR4Source`,
whose pre-adopted `responseKinds` an archive import extracts with. The live
`fhir-r4-client-collector` scraping plan (browser-driven, in `slices/collector`)
consumes the same response-kind tuple by reference, so the two
consumers can never disagree on a decode. It is the first of the per-source
packages; `rexall-be-well-source`, `shoppers-drugmart-source`, and
`web-trace-source` follow the same shape.

## Shape

- `src/response-kinds/patient-response-kind.ts` — `…/Patient/<id>` → one R4 `Patient`.
- `src/response-kinds/observation-response-kind.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/response-kinds/observation-list-response-kind.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- `src/recognize-fhir-root.ts` — `recognizeFhirRoot(matcher)`, which turns a
  fused `UrlMatch.UrlMatcher` into the kind's `tryRecognize`: `Some` a
  `PROTOCOL`-tier `RecognizedUrlData` whose `source` is `{ system: root, baseUrl:
root }` (root = the matcher's own capture, so there is no second hand-written
  root regex to keep in step), `None` when the matcher does not claim the URL. A
  FHIR server spells its own references absolutely under that same prefix, which
  is why root rides both `system` and `baseUrl`.
- `src/source.ts` — `fhirR4Source`, the package's one exported surface: the
  `SourceDescriptor` (`name: 'fhir-r4'`, display strings, and the pre-adopted
  `responseKinds`). Both consumers reach the tuple through
  `fhirR4Source.responseKinds`, sharing it by reference.
- `src/response-kinds.ts` — `fhirR4ResponseKinds` (internal, the descriptor's
  `responseKinds`): the tuple (Patient, Observation, Observation-list, in that
  order), widened to `HttpResponseKind<FhirResource>` so the per-kind adoption
  guard has its element type, and mapped through `adoptUnderRecognizedRoot` — so
  each resource is keyed under the root of the URL it arrived on, the identity
  read per response from the kind's own `tryRecognize`, no single system
  inferred. A module-level constant (the combinator takes no source parameter),
  so the array is stable by identity, which the config deep-equal suites and the
  live==archive parity rest on. Kinds only — no navigation, no provenance.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`RecognizedUrlData`), `fhir-r4` (resources + `identity`'s
`adoptUnderRecognizedRoot`), `effect`, and `kitchen-sink` — nothing else. In
particular it must **never** import anything from `slices/collector`
(`fhir-r4-client-collector` depends on this package; the live config/plan/form
are its concern) or `slices/importer` (whose `har-importer-core` consumes this
package's `fhirR4Source.responseKinds`).

The source-vs-live **parity** tests — the ones that need the live
`InstanceConfig`/`scrapingPlan` — therefore live in
`fhir-r4-client-collector/src/source-parity.test.ts`, next to the config they
depend on; this package's response-kind suites and `response-kinds.test.ts`
pin only its own surface's behaviour.

## Traps

- **`responseKinds` order is not load-bearing here, and should stay that
  way.** `mustHaveQuery` on the Observation-list pattern keeps it disjoint from
  the single-`Observation` pattern; without it the higher-specificity-wins
  routing would fall back to list order and the broader pattern could shadow the
  narrower. Specificity only disambiguates the importer's cross-source pool —
  within one source the kinds must stay disjoint.
- **Cross-server references dangle, by design.** A relative reference
  (`Patient/x` on an `Observation`) is rewritten under that resource's _own_
  root, so a same-server capture links up and a genuine cross-server reference
  does not. That is FHIR-correct — cross-server references are meant to be
  absolute.
- **A seam drift guard pins `HttpResponseKind<FhirResource>` against
  `AdoptableEntity`.** The response-kind tuple maps through
  `adoptUnderRecognizedRoot`, whose parameter is `fhir-r4/identity`'s structural
  `AdoptableEntity` (that package sits below `http-extraction` and cannot import
  it). The two shapes are checked against each other here so a drift in either is
  a compile error in this package rather than a silent divergence.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [fhir-r4-client-collector AGENTS.md](../../collector/fhir-r4-client-collector/AGENTS.md)
  — the live collector built from these entities (config, plan, provenance,
  form).
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
