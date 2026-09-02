# AGENTS.md — slices/http-extraction/shoppers-drugmart-source

The **Shoppers Drug Mart source**: the single definition of how the Shoppers
"mypharmacy" portal's bespoke JSON decodes into FHIR R4 resources, exported as
one `SourceDescriptor` value — `shoppersDrugMartSource`, whose pre-adopted
`responseKinds` an archive import extracts with. The live
`shoppers-drugmart-collector` scraping plan (browser-driven, in
`slices/collector`) consumes the same response-kind tuple by reference, so the
two consumers can never disagree on a decode. Unlike `fhir-r4-source` (which
decodes native FHIR JSON) and `rexall-be-well-source` (which decodes a carebook
STU3 dialect), this source **synthesizes** R4 resources directly from
non-FHIR portal JSON.

## Shape

- `src/response-kinds/customer-response-kind.ts` — `…/customers/<uuid>` → one
  demographic `Patient` per managed person + a linked account `Patient` keyed by
  `pcid`.
- `src/response-kinds/prescription-response-kind.ts` —
  `…/prescriptions/:uuid/prescription-status` → one `MedicationRequest` + one
  `MedicationDispense` per dispense entry.
- `src/response-kinds/prescription-history-response-kind.ts` —
  `…/prescription-history?customerId=…` → one `MedicationDispense` per history
  entry (no Patient, no MedicationRequest).
- `src/response-kinds/medication-wire.ts` — the `medicationCodeableConcept`
  builder (brand/chemical text + DIN coding) shared by the two dispense-emitting
  entities.
- `src/shoppers.ts` — the identifier/coding-system URL catalogue
  (`ShoppersIdentifierSystem`, `DIN_CODE_SYSTEM`,
  `PRESCRIPTION_STATUS_TYPE_SYSTEM`).
- `src/source-system.ts` — `SHOPPERS_DRUGMART_SYSTEM`, the Wildflower-minted
  `sid` URI each kind's `tryRecognize` mints and adoption keys under.
- `src/dates.ts` — `decodesAsDateTime` / `firstDateTime` date-validation helpers
  shared across entities.
- `src/response-kinds.ts` — `shoppersDrugMartResponseKinds` (internal, the
  descriptor's `responseKinds`): the three kinds widened to
  `HttpResponseKind<FhirResource>` and mapped through `adoptUnderRecognizedRoot`.
  A module-level constant, stable by identity.
- `src/source.ts` — `shoppersDrugMartSource`, the package's primary export: the
  `SourceDescriptor` (`name: 'shoppers-drugmart'`, display strings, and the
  pre-adopted `responseKinds`).

## Layering

Pure like a `-core`: no DOM, no `fs`, no React. Depends on
`http-extraction-fundamentals` (`HttpResponseKind`, `UrlMatch`, `Specificity`,
`RecognizedUrlData`), `fhir-r4` (resources + `identity`'s
`adoptUnderRecognizedRoot`), `effect`, and `kitchen-sink` — nothing else. In
particular it must **never** import anything from `slices/collector`
(`shoppers-drugmart-collector` depends on this package; the live
config/plan/form are its concern) or `slices/importer` (whose
`har-importer-core` consumes this package's
`shoppersDrugMartSource.responseKinds`).

## Traps

- **`responseKinds` order is not load-bearing, and should stay that way.** The
  three recognizers are disjoint by construction (different path segments:
  `customers/<uuid>`, `prescriptions/<uuid>/prescription-status`,
  `prescription-history?customerId=…`), so specificity-based routing never
  reaches the tie-breaking list order.
- **Every recognizer matches `/api/<anything>/…`**, not a literal `p1`/`v1` —
  the capture shows `p1`, the docs say `v1`, so the pattern is version-agnostic.

## References

- [slices/http-extraction/AGENTS.md](../AGENTS.md) — the slice this package
  belongs to.
- [http-extraction-fundamentals AGENTS.md](../http-extraction-fundamentals/AGENTS.md)
  — the vocabulary this package is written against.
- [shoppers-drugmart-collector AGENTS.md](../../collector/shoppers-drugmart-collector/AGENTS.md)
  — the live collector built from these entities (config, plan, provenance,
  form).
- [Source Identity Explanation](../../collector/docs/Source%20Identity%20Explanation.md)
  — why a resource is re-keyed under a derived local id.
