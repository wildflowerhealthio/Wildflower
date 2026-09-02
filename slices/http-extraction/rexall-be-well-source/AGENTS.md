# AGENTS.md — slices/http-extraction/rexall-be-well-source

The **Rexall Be Well source**: the single definition of how the Rexall Be Well
portal's carebook STU3 dialect decodes into FHIR R4 resources, exported as one
`SourceDescriptor` value — `rexallBeWellSource`, whose pre-adopted
`responseKinds` an archive import extracts with. The live
`rexall-be-well-collector` scraping plan (browser-driven, in `slices/collector`)
consumes the same response-kind tuple by reference, so the two consumers can
never disagree on a decode.

## Shape

- `src/response-kinds/profile-response-kind.ts` — `…/carebook/profile` → one R4
  `Patient`.
- `src/response-kinds/medication-list-response-kind.ts` —
  `…/carebook/medications` → R4 `MedicationRequest` + `MedicationDispense`
  resources.
- `src/carebook.ts` — the carebook STU3 dialect decoder.
- `src/promote.ts` — STU3-to-R4 promotion helpers.
- `src/bundle.ts` — searchset Bundle unwrapping.
- `src/source-system.ts` — `REXALL_CAREBOOK_SYSTEM`, the Wildflower-minted
  `sid` URI each kind's `tryRecognize` mints and adoption keys under.
- `src/response-kinds.ts` — `rexallBeWellResponseKinds` (internal): the kinds
  mapped through `adoptUnderRecognizedRoot`, stable by identity at module scope.
- `src/source.ts` — `rexallBeWellSource`, the package's primary export.

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals`, `fhir-r4`, `effect`, and `kitchen-sink`. Never
imports from `slices/collector` or `slices/importer`.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [rexall-be-well-collector AGENTS.md](../../collector/rexall-be-well-collector/AGENTS.md)
  — the live collector built from these entities.
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
