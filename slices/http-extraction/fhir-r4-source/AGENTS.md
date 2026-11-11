# AGENTS.md — slices/http-extraction/fhir-r4-source

The **FHIR R4 source**: the single definition of how FHIR R4 traffic decodes
into resources, exported as one `SourceDescriptor` value — `fhirR4Source`,
whose `responseKinds` an archive import (`har-importer-core`) extracts with. It is the first of the per-source packages;
`rexall-be-well-source` and `shoppers-drugmart-source` follow the same shape.

## Shape

- `src/response-kinds/patient-response-kind.ts` — `…/Patient/<id>` → one R4
  `Patient`, keyless when the server sent it with no id.
- `src/response-kinds/observation-response-kind.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/response-kinds/observation-list-response-kind.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- `src/response-kinds/document-reference-response-kind.ts` —
  `…/DocumentReference/<id>` → one R4 `DocumentReference`, its attachments'
  and references' `Binary/<id>` detached to the server's absolute URL for the
  Binary.
- `src/response-kinds/binary-response-kind.ts` — `…/Binary/<id>` → one R4
  `Binary`, keyless, read only when the server served it as a JSON `Binary`
  resource: the body is parsed as JSON once, a read served as its raw
  content (a PDF body, say) holds no record, and JSON that is no `Binary`
  fails to parse. The HAR importer names the record by the read's URL, its
  source URL.
- `src/fhir-server-response-kind.ts` — `FhirServerResponseKind.make({ name,
  url, readRecords })`, the one way a kind here is built: it declares its
  `UrlMatch.UrlMatcher` and how it reads the server's records off a body.
  `tryRecognize` is a `PROTOCOL`-tier claim on whatever the matcher claims;
  `parse` is one linear `Effect`: the root the same matcher yields for the
  response's URL (a `ParseError` for one it does not claim), the records off
  `extractJson` of the body, each detached with `fhir-r4-adoption`'s
  `DetachedResource.fromServerRecord(root)`, so there is no second root regex
  to keep in step. That keys each type in `<root>/<Type>` and reads the
  server's absolute spelling of its own references as the relative one. Each
  kind is typed by the resource it reads,
  `HttpResponseKind<DetachedResource.Detached<…>>`.
- `src/source.ts` — `fhirR4Source`, the package's one exported surface: the
  `SourceDescriptor` (`name: 'fhir-r4'`, display strings, and the
  `responseKinds`). Consumers reach the tuple through
  `fhirR4Source.responseKinds`, sharing it by reference.
- `src/response-kinds.ts` — `fhirR4ResponseKinds` (internal, the descriptor's
  `responseKinds`): the tuple (Patient, Observation, Observation-list,
  DocumentReference, Binary, in that order), as
  `HttpResponseKind<DetachedResource.Type>`. Each parses the
  server's resources and detaches them under the response URL's root. A module-level constant, so the array is stable by
  identity and every consumer shares the same kinds. Kinds only — no
  navigation, no provenance.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`RecognizedUrlData`), `fhir-r4` (resources), `fhir-r4-adoption`
(`DetachedResource`), `effect`, and `kitchen-sink` — nothing else. In
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
  (`Patient/x` on an `Observation`) is detached under that resource's _own_
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
  — why a resource is detached, keyed, and stored under a derived local id.
