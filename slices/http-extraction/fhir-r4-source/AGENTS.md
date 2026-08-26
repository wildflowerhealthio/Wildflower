# AGENTS.md — slices/http-extraction/fhir-r4-source

The **FHIR R4 source**: the single definition of how FHIR R4 traffic decodes
into resources, the recognition surface built from it, and the assembled
`fhirR4Source` value consumers extract with. The live
`fhir-r4-client-collector` scraping plan (browser-driven, in
`slices/collector`) consumes the same entity tuple, so the two consumers can
never disagree on a decode. It is the first of the per-source packages;
`rexall-be-well-source`, `shoppers-drugmart-source`, and a possible
`web-trace-source` follow the same shape.

## Shape

- `src/entities/patient-entity.ts` — `…/Patient/<id>` → one R4 `Patient`.
- `src/entities/observation-entity.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/entities/observation-list-entity.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- `src/plan-entities.ts` — the `fhirR4EntityDefinitions` tuple (Patient,
  Observation, Observation-list, in that order), the **single definition** both
  this package's source surface and the live plan consume.
- `src/recognizer.ts` — `fhirR4Recognizer` (claims a response set when any URL
  matches an entity pattern; specificity `50`, the portal > FHIR > catch-all
  middle rung) and `fhirRootOf(url)` (the per-URL root primitive — the prefix
  before a `/Patient`/`/Observation` segment). This package owns "what a FHIR
  R4 root is".
- `src/source-entities.ts` — `fhirR4SourceEntities`: the shared tuple's
  decode, keying each resource under the root of the URL it arrived on — no
  single system inferred; entities only, no navigation, no provenance.
- `src/source.ts` — **`fhirR4Source`**, the whole source as one
  `Source.Source<FhirResource>` value: the recognizer's fields, the
  `'fhir-r4'` tag, the `fhirR4SourceEntities` array, and `fhirRootOf`. This is
  what `importer-core`'s `sources` list registers.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`EntityDefinition`, `UrlMatch`, `Extraction`,
`Recognizer`, `Source`), `fhir-r4` (resources + identity), `effect`, and
`kitchen-sink` — nothing else. In particular it must **never** import anything
from `slices/collector` (`fhir-r4-client-collector` depends on this package;
the live config/plan/form are its concern) or `slices/importer` (whose
`importer-core` registers this package's `fhirR4Source`).

The source-vs-live **parity** tests — the ones that need the live
`InstanceConfig`/`scrapingPlan` — therefore live in
`fhir-r4-client-collector/src/source-parity.test.ts`, next to the config they
depend on; this package's `recognizer.test.ts` and `source-entities.test.ts`
pin only its own surface's behaviour.

## Traps

- **`entityDefinitions` order is not load-bearing here, and should stay that
  way.** `mustHaveQuery` on the Observation-list pattern keeps it disjoint from
  the single-`Observation` pattern; without it the first `isFoundAt` match would
  silently win.
- **Cross-server references dangle, by design.** A relative reference
  (`Patient/x` on an `Observation`) is rewritten under that resource's _own_
  root, so a same-server capture links up and a genuine cross-server reference
  does not. That is FHIR-correct — cross-server references are meant to be
  absolute.
- **The recognizer reads URLs, not bodies.** `fhirR4Recognizer.claims` is true
  when any response URL matches one of the three entities' `isFoundAt` —
  reusing the entities' own patterns, so recognizer and entities can't disagree
  on what a FHIR URL is.

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
