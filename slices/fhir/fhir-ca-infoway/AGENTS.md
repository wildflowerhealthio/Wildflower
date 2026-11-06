# AGENTS.md — slices/fhir/fhir-ca-infoway

Canadian identifiers for FHIR R4, in one place every Canadian source and the
identity matcher share: Canada Health Infoway's provincial health card naming
systems, and the schema from a health card number as printed to its
`Identifier`.
Pure: no DOM, no `fs`, no React. Infoway's systems are jurisdictional, not
R4, so they live here rather than in `fhir-r4`.

## Shape

- `src/health-card-province.ts` — **`HealthCardProvince`**: the province that
  issued a card (`Schema`, a `Schema.Literal('ON', 'BC', 'Other')`): Ontario
  and British Columbia by ISO 3166-2 code, `Other` for anywhere else; with
  `all` (picker order), `names` (English names, `Other` is "Other province")
  and `is` (reads a `<select>`'s value back).
- `src/health-card-identifier.ts` — **`HealthCardIdentifier`**:
  - `HealthCardNumberSystem`, each province's naming system. Ontario
    (`…/NamingSystem/ca-on-patient-hcn`) and British Columbia
    (`…/NamingSystem/ca-bc-patient-healthcare-id`, the
    [BC PHN](https://bcgov.github.io/MOH-HCIM-FHIR/identifiers.html)) are
    from Infoway's
    [Canadian URI Registry](https://simplifier.net/canadianuriregistry).
    `Other` is Wildflower-minted
    (`https://wildflowerhealth.io/fhir/sid/health-card-number`): the registry
    has a system per jurisdiction and none for a number whose jurisdiction is
    not known.
  - `ONTARIO_HEALTH_CARD_VERSION_CODE_URL`, Ontario Health's `HCNVersionCode`
    extension (`http://ontariohealth.ca/fhir/StructureDefinition/ca-on-setp-ext-health-card-version-code`,
    package `ca.on.oh-setp`, a `valueString` on `Patient.identifier`).
  - `JURISDICTIONAL_HEALTH_NUMBER_TYPE`, HL7 v2-0203 `JHN`, the `type` of an
    `Other` identifier, whose system alone does not say what it is.
  - `Schema` / `Type`: `fhir-r4`'s encoded `Identifier` with `system` and a
    non-empty `value` always set, so a source can key a record by it.
  - `FromPrinted(province)`, a `Schema<Type, string>` from the number as
    printed. Decoding strips spaces and hyphens anywhere, then applies the
    province's rule. Ontario: exactly ten digits in `value`, then an
    optional one- or two-letter version code in the extension (none, no
    extension). British Columbia: exactly ten digits in `value`. `Other`: the
    rest as printed in `value`, letters kept and no version code split off.
    A number that is not the province's shape fails with a `ParseError`
    whose message names the shape expected (`not a British Columbia PHN:
    expected exactly ten digits`); `Other` fails only when nothing is left.
    Encoding prints the number back (`1234567890 AB`).
- `src/index.ts` — the two namespaces.

## Layering

Depends on `fhir-r4` (`/data-types`, for the `Identifier` wire schema and
`narrowFields`) and `effect`. Imports no importer, source or app: they import
it.

## Guardrails

- **Shape, not check digits.** A rule checks that a number has its province's
  shape and no more: Ontario's and British Columbia's check digits are not
  verified ([#1523](https://github.com/wildflowerhealthio/Wildflower/issues/1523)).
  A source that decodes a number with `FromPrinted` lets the failure surface
  (LifeLabs fails the import), so a wrong province choice is visible rather
  than keying a record some other way.
- **The systems are persisted wire format.** A record keyed by a health card
  number (a LifeLabs Patient whose report prints no `Patient ID`) is stored
  under an id derived from its system and value, so changing a system or what
  a rule writes as `value` re-keys every such record already stored.
- **No importer declares a health card system URL itself.** A source that
  reads a health card number decodes it with `HealthCardIdentifier.FromPrinted`,
  so every source and the matcher name a card the same way.

## References

- [slices/fhir AGENTS.md](../AGENTS.md) — the fhir slice and its packages.
- [Source Identity Explanation](../../http-extraction/fhir-r4-adoption/docs/Source%20Identity%20Explanation.md)
  — how a record's key identifier becomes the id it is stored under.
