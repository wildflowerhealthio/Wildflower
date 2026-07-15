# AGENTS.md — slices/emr/fhir-stu3

Just-enough FHIR **STU3** (Rexall/carebook dialect) wire schemas plus a
STU3 → R4 transform. Part of the Rexall collector epic: the Rexall tunnel API
(`rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/…`) serves STU3
searchset Bundles in a narrow, extension-heavy carebook dialect, and the local
store accepts the `fhir-r4` slice's R4 types.

## Decided scope: just-enough dialect, not faithful STU3

Model only what the carebook responses actually emit, lenient about unknown
fields, so the slice stays small and testable against captured payloads. If a
future STU3 source appears, generalize then. Unknown fields/extensions must not
fail decode — they are ignored (Effect's default excess-property behaviour),
except carebook extensions, which are modelled as ordinary `Extension`s and so
survive decode verbatim.

## Layout

- `src/schemas/` — decode schemas: `carebook` (extension/identifier/coding
  system constants), `medication` (contained `Medication`), `medication-request`,
  `medication-dispense`, `bundle` (searchset). Exported via `fhir-stu3/schemas`.
- `src/transform/` — STU3 → R4 transforms producing the `fhir-r4` slice's
  decoded resource types. Exported via `fhir-stu3/transform`.
- `src/fixtures/` — captured-shape bundle fixtures used by the tests.

## Guardrails

- **Reuses `fhir-r4` datatypes.** The carebook STU3 wire shapes for the shared
  datatypes (`Coding`, `CodeableConcept`, `Quantity`, `Identifier`, `Reference`,
  `Annotation`, `Extension`, `Duration`, `Period`, `Bundle`) are identical to
  R4, so the STU3 schemas import them from `fhir-r4/data-types` and the STU3-only
  files cover just the dialect deltas (`requester.agent`, contained `Medication`,
  carebook extensions). This makes the transform a near identity for shared
  fields.
- **Declaration-emit portability (TS2883).** Building schemas from fhir-r4's
  datatype schemas embeds fhir-r4's internal decoded interfaces
  (`ExtensionType`, `ReferenceType`, `IdentifierType`) in the inferred types.
  `tsgo`'s `.d.ts` emit can only name those because `fhir-r4/data-types`
  re-exports them at the top level — keep those exports if you touch fhir-r4.
  With them in place the plain `typeof Struct.Type` / `typeof Struct.Encoded`
  annotation packs cleanly; no hand-written wire interfaces are needed.

## Fixtures caveat

The fixtures in `src/fixtures/` are **synthesized from the epic's dialect notes**
(exact extension URLs, identifier systems, and resource shapes), not real
captured payloads. Validate them against redacted real captures before the
rexall-collector ships, and adjust the `carebook` constants / schemas to match
anything the captures reveal.

## References

- [slices/emr/AGENTS.md](../AGENTS.md) — the emr slice overview
- [fhir-r4](../fhir-r4) — the R4 target types and datatype schemas this slice reuses
