# AGENTS.md — slices/http-extraction/rexall-be-well-source

The **Rexall Be Well source**: the carebook STU3 dialect (extension/identifier/
coding-system constants, Bundle shapes, extension promotion) and the
profile/medication-list response kinds that define how Rexall letsbewell.ca
traffic decodes into FHIR R4 resources, assembled as a `SourceDescriptor`. The
live `rexall-be-well-collector` scraping plan (browser-driven, in
`slices/collector`) and the archive importer's pool (`har-importer-core`) both
consume the same response-kind tuple by reference, so the two consumers can
never disagree on a decode. Follows the same shape as `fhir-r4-source`.

## Shape

- `src/carebook.ts` — the dialect catalogue: carebook extension URLs, identifier
  systems, and coding systems.
- `src/promote.ts` — the dialect post-step that moves carebook extensions into
  the conventional R4 fields that already exist for them.
- `src/bundle.ts` — the concrete carebook searchset Bundles
  (`MedicationRequestBundle`, `MedicationDispenseBundle`, mixed
  `MedicationBundle`), built by feeding the `fhir-stu3-as-r4/schemas` resource
  schemas through that slice's generic `Bundle.searchsetBundle` factory.
- `src/source-system.ts` — `REXALL_CAREBOOK_SYSTEM`, the Wildflower-minted `sid`
  URI that keys every resource this source imports. Its own leaf module (not
  `config.ts`) so the response kinds can read it without importing anything that
  imports them.
- `src/response-kinds/profile-response-kind.ts` — recognizes `…/profile/v2/me`
  and synthesizes an R4 `Patient` from the (non-FHIR) carebook profile JSON.
  Uses `recognizePortal` with an unconstrained host pattern — the user's HAR
  review step is the only guard against false positives in archive import.
- `src/response-kinds/medication-list-response-kind.ts` — recognizes the
  prescriptions page's `…/pharmacy/Location?…_revinclude=…` searchset and
  decodes the heterogeneous bundle, splitting off `MedicationRequest` /
  `MedicationDispense` and running each survivor through `promote.ts`.
- `src/response-kinds.ts` — `rexallBeWellResponseKinds` (internal, the
  descriptor's `responseKinds`): the tuple mapped through
  `adoptUnderRecognizedRoot` at module scope, so two plans from one config
  share the frozen array by identity.
- `src/extract-json.ts` — XHR/JSON-viewer body normalizer the entities decode
  through.
- `src/source.ts` — `rexallBeWellSource`, the package's main export: the
  `SourceDescriptor` (`name: 'rexall-be-well'`, display strings, and the
  pre-adopted `responseKinds`).
- `src/index.ts` — barrel exporting `rexallBeWellSource` and
  `REXALL_CAREBOOK_SYSTEM`.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`recognizePortal`), `fhir-r4` (resources + `identity`'s
`adoptUnderRecognizedRoot`), `fhir-stu3-as-r4` (the STU3⇄R4 schemas the
bundles decode with), `effect`, and `kitchen-sink` — nothing else. In particular
it must **never** import anything from `slices/collector`
(`rexall-be-well-collector` depends on this package; the live config/plan/form
are its concern) or `slices/importer` (whose `har-importer-core` consumes this
package's `rexallBeWellSource.responseKinds`).

## Traps

- **`responseKinds` order is not load-bearing here.** The profile pattern and
  the medication-list pattern are structurally disjoint (different URL
  segments); `mustHaveQuery` on the medication-list pattern adds a second
  disjointness axis. Within one source the kinds must stay disjoint.
- **The profile pattern's host is unconstrained.** `recognizePortal` uses a
  regex that matches any host. In a live collector the scraping plan navigates
  only `letsbewell.ca`, so the host is implicitly scoped. In archive import the
  flat pool routes every archived response through `tryRecognize`, so a
  non-Rexall URL whose path happens to end in `/profile/v2/me` would match. The
  user's per-URL review step in the importer UI is the only guard against false
  positives.
- **`REXALL_CAREBOOK_SYSTEM` is a persisted wire format.** It is the hash domain
  for every derived local id and the `Identifier.system` written beside every
  carebook id, so changing it orphans everything already imported from Rexall.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [fhir-r4-source AGENTS.md](../fhir-r4-source/AGENTS.md) — the sibling source
  package whose shape this one follows.
- [rexall-be-well-collector AGENTS.md](../../collector/rexall-be-well-collector/AGENTS.md)
  — the live collector built on this source (config, plan, provenance, form).
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
