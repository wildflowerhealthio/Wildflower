# AGENTS.md — slices/collector/rexall-be-well-collector

The **Rexall Be Well carebook dialect** for the Rexall collector epic. The Rexall
tunnel API (`rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3/…`)
serves FHIR **STU3** searchset Bundles in a narrow, extension-heavy carebook
dialect. This package holds everything Rexall/carebook-specific; the generic
STU3⇄R4 schema machinery lives in `slices/emr/fhir-stu3-as-r4`.

## Layout

- `src/carebook.ts` — the dialect catalogue: carebook extension URLs, identifier
  systems, and the DIN coding system. Grouped here so schema/consumer code
  references one place rather than sprinkling opaque URLs around.
- `src/bundle.ts` — the concrete carebook searchset Bundles (`MedicationRequestBundle`,
  `MedicationDispenseBundle`, mixed `MedicationBundle`), built by feeding the
  `fhir-stu3-as-r4/schemas` resource schemas through that slice's generic
  `Bundle.searchsetBundle` factory. Wrap the `R4FromStu3Schema` variants instead
  to decode a bundle straight to R4 (see `bundle.test.ts`).
- `src/fixtures/` — captured-shape bundle fixtures used by the tests.

Exported via the package root (`rexall-be-well-collector`).

## Fixtures caveat

The fixtures in `src/fixtures/` are **synthesized from the epic's dialect notes**
(exact extension URLs, identifier systems, and resource shapes), **not real
captured payloads**. Validate them — and the `carebook` constants (extension /
identifier URLs, DIN system) — against redacted real captures before the Rexall
collector consumes this, and adjust `carebook.ts` / the fixtures to match anything
the captures reveal.

## Scope

This package is the **dialect home only**. It does not yet register a `Remote`
into `collector-core` — that wiring (and the actual sniffer/collector surface) is
a later step in the epic.

## References

- [fhir-stu3-as-r4](../../emr/fhir-stu3-as-r4) — the STU3⇄R4 schemas these bundles
  are built from
- [fhir-r4](../../emr/fhir-r4) — the R4 resource types the schemas decode to
- [collector-fundamentals](../collector-fundamentals) — the collector primitives a
  future Rexall `Remote` would build on
