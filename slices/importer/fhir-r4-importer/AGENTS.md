# AGENTS.md — slices/importer/fhir-r4-importer

The **FHIR R4 importer project**: the single definition of how FHIR R4 traffic
decodes into resources, shared by the two consumers that must never disagree —
the live `fhir-r4-client-collector` scraping plan (browser-driven, in
`slices/collector`) and the archive importer (`importer-core`, this slice). It
is the first of the per-source importer projects; `shoppers-drugmart-importer`,
`rexall-be-well-importer`, and `web-trace-importer` follow the same shape.

## Shape

- `src/entities/patient-entity.ts` — `…/Patient/<id>` → one R4 `Patient`.
- `src/entities/observation-entity.ts` — `…/Observation/<id>` → one R4
  `Observation`.
- `src/entities/observation-list-entity.ts` — `…/Observation?…` → the
  `Observation`s of a searchset `Bundle`, dropping-and-counting entries that
  carry no resource.
- `src/plan-entities.ts` — the `fhirR4EntityDefinitions` tuple (Patient,
  Observation, Observation-list, in that order), the **single definition** both
  the live plan and the offline surface consume.
- `src/offline.ts` — the **offline extraction surface**, read by an archive
  importer with no live sniffer. Three exports, all reading the same evidence
  the live collector does: `offlineEntities` (the shared tuple's decode, keying
  each resource under the root of the URL it arrived on — no single system
  inferred; entities only, no plan/provenance), `fhirR4Recognizer` (claims a
  response set when any URL matches an entity pattern; specificity `50`, the
  portal > FHIR > web-trace middle rung), and `fhirRootOf(url)` (the per-URL
  root primitive both build on — the prefix before a `/Patient`/`/Observation`
  segment). This package owns "what a FHIR R4 root is".
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`collector-fundamentals` (`EntityDefinition`, `UrlMatch`, the replay
vocabulary), `fhir-r4` (resources + identity), `effect`, and `kitchen-sink` —
nothing else. In particular it must **never** import `fhir-r4-client-collector`
(that package depends on this one; the live config/plan/form are its concern)
or `importer-core` (which registers this package's offline surface).

The offline-vs-live **parity** tests — the ones that need the collector's
`InstanceConfig`/`scrapingPlan` — therefore live in
`fhir-r4-client-collector/src/offline-parity.test.ts`, next to the config they
depend on; this package's `offline.test.ts` pins only the offline surface's own
behaviour.

## Traps

- **`entityDefinitions` order is not load-bearing here, and should stay that
  way.** `mustHaveQuery` on the Observation-list pattern keeps it disjoint from
  the single-`Observation` pattern; without it the first `isFoundAt` match would
  silently win.
- **Cross-server references dangle, by design.** A relative reference
  (`Patient/x` on an `Observation`) is rewritten under that resource's _own_
  root, so a same-server capture links up and a genuine cross-server reference
  does not. That is FHIR-correct — cross-server references are meant to be
  absolute — and no worse than the live path.
- **The recognizer reads URLs, not bodies.** `fhirR4Recognizer.claims` is true
  when any response URL matches one of the three entities' `isFoundAt` —
  reusing the entities' own patterns, so recognizer and entities can't disagree
  on what a FHIR URL is.

## References

- [fhir-r4-client-collector AGENTS.md](../../collector/fhir-r4-client-collector/AGENTS.md)
  — the live collector built from these entities (config, plan, provenance,
  form).
- [slices/importer/AGENTS.md](../AGENTS.md) — the importer slice this package
  belongs to, and the registry that consumes the offline surface.
- [slices/collector/AGENTS.md](../../collector/AGENTS.md) —
  `collector-fundamentals`'s model + `./replay`, the vocabulary this package is
  written against.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
