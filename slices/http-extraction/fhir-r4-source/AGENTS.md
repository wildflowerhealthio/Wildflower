# AGENTS.md — slices/http-extraction/fhir-r4-source

The **FHIR R4 source**: the single definition of how FHIR R4 traffic decodes
into resources, exported as one `SourceDescriptor` value — `fhirR4Source`,
whose pre-adopted `responseKinds` an archive import (`har-importer-core`)
extracts with. It is the first of the per-source packages;
`rexall-be-well-source` and `shoppers-drugmart-source` follow the same shape.

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
  `responseKinds`). Consumers reach the tuple through
  `fhirR4Source.responseKinds`, sharing it by reference.
- `src/response-kinds.ts` — `fhirR4ResponseKinds` (internal, the descriptor's
  `responseKinds`): the tuple (Patient, Observation, Observation-list, in that
  order), widened to `HttpResponseKind<FhirResource>`, and mapped through
  `fhir-r4-adoption`'s `adoptUnderRecognizedRoot` — so
  each resource is keyed in `<root>/<Type>` of the URL it arrived on, the identity
  read per response from the kind's own `tryRecognize`, no single system
  inferred. A module-level constant (the combinator takes no source parameter),
  so the array is stable by identity and every consumer shares the same kinds.
  Kinds only — no navigation, no provenance.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`RecognizedUrlData`), `fhir-r4` (resources), `fhir-r4-adoption`
(`adoptUnderRecognizedRoot`), `effect`, and `kitchen-sink` — nothing else. In
particular it must **never** import anything from `slices/importer` (whose
`har-importer-core` consumes this package's `fhirR4Source.responseKinds`).
This package's response-kind suites and `response-kinds.test.ts` pin only its
own surface's behaviour.

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

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [har-importer-core AGENTS.md](../../importer/har-importer-core/AGENTS.md)
  — the archive importer that runs these kinds.
- [Source Identity Explanation](../fhir-r4-adoption/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
