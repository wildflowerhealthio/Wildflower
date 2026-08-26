# AGENTS.md — slices/importer/fhir-r4-importer

The **FHIR R4 importer project**: the single definition of how FHIR R4 traffic
decodes into resources, the recognition surface built from it, and the
assembled `fhirR4Importer` value the import pipeline registers. The live
`fhir-r4-client-collector` scraping plan (browser-driven, in
`slices/collector`) consumes the same entity tuple, so the two consumers can
never disagree on a decode. It is the first of the per-source importer
projects; `shoppers-drugmart-importer`, `rexall-be-well-importer`, and
`web-trace-importer` follow the same shape.

## Shape

- `src/entities/patient-entity.ts` — `…/Patient/<id>` → one R4 `Patient`.
- `src/entities/observation-entity.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/entities/observation-list-entity.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- `src/plan-entities.ts` — the `fhirR4EntityDefinitions` tuple (Patient,
  Observation, Observation-list, in that order), the **single definition** both
  this package's importer surface and the live plan consume.
- `src/recognizer.ts` — `fhirR4Recognizer` (claims a response set when any URL
  matches an entity pattern; specificity `50`, the portal > FHIR > catch-all
  middle rung) and `fhirRootOf(url)` (the per-URL root primitive — the prefix
  before a `/Patient`/`/Observation` segment). This package owns "what a FHIR
  R4 root is".
- `src/importer-entities.ts` — `fhirR4ImporterEntities`: the shared tuple's
  decode, keying each resource under the root of the URL it arrived on — no
  single system inferred; entities only, no navigation, no provenance.
- `src/importer.ts` — **`fhirR4Importer`**, the whole importer as one
  `Importer.Importer<FhirResource>` value: the recognizer's fields, the
  `'fhir-r4'` tag, `entitiesFor` (the archive-independent constant), and
  `rootOf`. This is what `importer-core`'s `importers` list registers.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`importer-fundamentals` (`EntityDefinition`, `UrlMatch`, `Extraction`,
`Recognizer`, `Importer`), `fhir-r4` (resources + identity), `effect`, and
`kitchen-sink` — nothing else. In particular it must **never** import anything
from `slices/collector` (`fhir-r4-client-collector` depends on this package;
the live config/plan/form are its concern) or `importer-core` (which registers
this package's `fhirR4Importer`).

The import-vs-live **parity** tests — the ones that need the live
`InstanceConfig`/`scrapingPlan` — therefore live in
`fhir-r4-client-collector/src/importer-parity.test.ts`, next to the config they
depend on; this package's `recognizer.test.ts` and `importer-entities.test.ts`
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

- [slices/importer/AGENTS.md](../AGENTS.md) — the importer slice this package
  belongs to, and the registry that consumes `fhirR4Importer`.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the
  vocabulary this package is written against.
- [fhir-r4-client-collector AGENTS.md](../../collector/fhir-r4-client-collector/AGENTS.md)
  — the live collector built from these entities (config, plan, provenance,
  form).
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
