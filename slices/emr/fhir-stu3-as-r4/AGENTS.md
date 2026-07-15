# AGENTS.md — slices/emr/fhir-stu3-as-r4

Just-enough FHIR **STU3** wire schemas that decode **straight to the `fhir-r4`
slice's R4 resource types**. Part of the Rexall collector epic: the Rexall tunnel
serves STU3 searchset payloads, and the local store accepts R4 — this slice is
the STU3⇄R4 bridge. The Rexall-specific carebook dialect (extension URLs,
concrete bundle shapes, fixtures) lives in `slices/collector/rexall-be-well-collector`,
not here.

## Decided scope: just-enough STU3, not faithful STU3

Model only the STU3 fields the Rexall payloads emit, lenient about unknown
fields, so the slice stays small and testable. Unknown fields/extensions must
not fail decode — they are ignored (Effect's default excess-property behaviour);
extensions are modelled as ordinary `Extension`s and survive decode verbatim.

## Two schemas per resource

Each `src/schemas/<resource>.ts` exports **two** schemas:

- **`Schema`** — the clean STU3 shape: decodes/encodes STU3 wire ⇄ a decoded STU3
  value (e.g. `MedicationRequest.requester` is the STU3 `{ agent, onBehalfOf }`
  backbone).
- **`R4FromStu3Schema`** — an Effect `Schema.transformOrFail` whose **decoded
  output is the fhir-r4 resource** (`Schema<R4Resource.Type, Stu3Wire>`):
  - **decode** (STU3 → R4) is total: it overlays the mapped fields onto the R4
    resource's `empty` default (`R4Resource.empty` from `fhir-r4`). STU3-only data
    with no R4 slot (e.g. `requester.onBehalfOf`) is dropped, never failed.
  - **encode** (R4 → STU3) **fails** (`ParseResult.fail`) when the R4 value carries
    data outside the STU3-representable subset — an R4-only field (`performer`,
    `partOf`, …), an R4-only `status`/`intent` member, or a `Quantity.comparator`.
    This is the direction that isn't a bijection.
  - The encode callback re-normalizes its input with `Schema.decodeSync(typeSchema(R4))`
    first: `transformOrFail` hands encode the _encoded_ side, where absent
    optionals arrive as `undefined`, and decoding fills them back to `null`/`[]`.

Relocated shared logic now lives in `fhir-r4`, not here: `Quantity.fromSimpleQuantity`
(SimpleQuantity→Quantity widening) and the `.empty` defaults on `Medication` /
`MedicationRequest` / `MedicationDispense` / `MedicationRequestDispenseRequest` /
`IdentifierAndReference.emptyReference`.

## Layout

- `src/schemas/` — `medication`, `medication-request`, `medication-dispense`
  (each: clean `Schema` + `R4FromStu3Schema`), `bundle` (the generic
  `searchsetBundle` factory over `fhir-r4`'s `Bundle`), `internal` (the
  `toSimpleQuantity` narrowing helper). Exported via `fhir-stu3-as-r4/schemas`.
- Tests colocated: clean-STU3 round-trips plus, per `R4FromStu3Schema`,
  STU3→R4→STU3 (over the representable STU3 subset) and R4→STU3→R4 (over an
  explicitly-constructed safe R4 subset) property tests, and encode-fails
  examples marking the subset boundary.

## Guardrails

- **Reuses `fhir-r4` datatypes.** The STU3 wire shapes for the shared datatypes
  are identical to R4, so the STU3 schemas import them from `fhir-r4/data-types`
  and cover only the dialect deltas. `medication[x]` / `statusReason[x]` choices
  use `choiceElementSetPassthroughFields` so both sides type-align (they resolve
  to `any`; modelling them explicitly instead triggers `no-unsafe-assignment`).
- **Declaration-emit portability (TS2883).** Building schemas from fhir-r4's
  datatype schemas embeds fhir-r4's internal decoded interfaces
  (`ExtensionType`, `ReferenceType`, `IdentifierType`, and `BundleValue` for the
  bundle factory) in the inferred types. `tsgo`'s `.d.ts` emit can only name those
  because `fhir-r4/data-types` re-exports them at the top level — keep those
  exports if you touch fhir-r4. `vp check` stays green when this leaks; only
  `vp pack` catches it.

## References

- [slices/emr/AGENTS.md](../AGENTS.md) — the emr slice overview
- [fhir-r4](../fhir-r4) — the R4 target types, datatype schemas, `.empty` defaults,
  and `Quantity.fromSimpleQuantity` this slice builds on
- [rexall-be-well-collector](../../collector/rexall-be-well-collector) — the
  carebook dialect (constants, concrete bundles, fixtures) that consumes these schemas
