# AGENTS.md — slices/fhir/fhir-ca-infoway

Canadian identifiers for FHIR R4, in one place every Canadian source and the
identity matcher share: Canada Health Infoway's provincial health card naming
systems, and how a health card number as printed becomes an `Identifier`.
Pure: no DOM, no `fs`, no React. Infoway's systems are jurisdictional, not
R4, so they live here rather than in `fhir-r4`.

## Shape

- `src/health-card-province.ts` — **`HealthCardProvince`**: the provinces
  whose cards this package names, by ISO 3166-2 code (`Schema`, a
  `Schema.Literal('ON', 'BC')`), with `all` (picker order), `names` (English
  names) and `is` (reads a `<select>`'s value back).
- `src/health-card-identifier.ts` — **`HealthCardIdentifier`**:
  `HealthCardNumberSystem`, each province's naming system from Infoway's
  [Canadian URI Registry](https://simplifier.net/canadianuriregistry)
  (Ontario `…/NamingSystem/ca-on-patient-hcn`, British Columbia
  `…/NamingSystem/ca-bc-patient-healthcare-id`, the
  [BC PHN](https://bcgov.github.io/MOH-HCIM-FHIR/identifiers.html));
  `ONTARIO_HEALTH_CARD_VERSION_CODE_URL`, Ontario Health's `HCNVersionCode`
  extension (`http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code`,
  package `ca.on.oh-setp`, a `valueString` on `Patient.identifier`); and
  `of(province, printed)`, the number as printed → its `Identifier` wire by
  that province's rule (`Type`: `fhir-r4`'s encoded `Identifier` with its
  `system` and `value` always set, so a source can key a record by it).
  Ontario: the number in `value` and its version code (the one or two
  letters after the last digit, any whitespace or hyphens before them
  dropped) in the
  extension, no extension when it prints none. British Columbia: the PHN in
  `value` as printed; a PHN has no version code.
- `src/index.ts` — the two namespaces.

## Layering

Depends on `fhir-r4` (`/data-types`, for the `Identifier` wire type only) and
`effect`. Imports no importer, source or app: they import it.

## Guardrails

- **No validation.** A number is written as printed after its province's
  split, never checked against the province's number format or check digit:
  a source reports what a card says, and is not the registry that issued it.
- **The systems are persisted wire format.** A record keyed by a health card
  number (a LifeLabs Patient whose report prints no `Patient ID`) is stored
  under an id derived from its system and value, so changing a system or the
  Ontario split re-keys every such record already stored.
- **No importer declares an Infoway system URL itself.** A source that reads
  a health card number writes it with `HealthCardIdentifier.of`, so every
  source and the matcher name a card the same way.

## References

- [slices/fhir AGENTS.md](../AGENTS.md) — the fhir slice and its packages.
- [Source Identity Explanation](../../http-extraction/fhir-r4-adoption/docs/Source%20Identity%20Explanation.md)
  — how a record's key identifier becomes the id it is stored under.
