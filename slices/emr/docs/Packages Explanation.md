# slices/emr/ Packages Explanation

EMR domain — patient/observation/binary FHIR resources, plus the FHIR R4 wire adapter. Two packages live here, both core (no platform adapters):

- **`emr-core`** — version-agnostic EMR domain: LiveStore tables, `RowSchema`s, repository/persistence helpers, search bindings. The data model is FHIR-shaped but not bound to a specific FHIR version. This is the source-of-truth schema layer.
- **`fhir-r4`** — the FHIR R4 wire adapter. Effect schemas that map FHIR R4 JSON ↔ `emr-core` RowSchemas, plus the `HttpApi` definition and handler implementation for the FHIR REST surface.

## Why two packages

`fhir-r4` is **not** suffixed `-core` because **there will never be a `fhir-r4-web` or `fhir-r4-node` adapter** — FHIR R4 is a wire protocol; clients consume the same JSON over the same HTTP regardless of platform. The slice-naming convention (`<name>-core` plus optional `-web`/`-node`/etc.) exists to enforce a layering boundary that doesn't apply here.

`fhir-r4` is **not folded into `emr-core`** because the EMR domain model is **FHIR-version-agnostic**. A future `fhir-r5` or `fhir-r4b` (or any non-FHIR wire format) would sit alongside `fhir-r4` and consume the same `emr-core` row schemas. Folding the wire adapter into the core would entangle versioning concerns with the domain model.

The dependency arrow is:

```plaintext
fhir-r4  →  emr-core
```

— never the reverse. `emr-core` does not import from `fhir-r4`.

## Cross-slice deps

`fhir-r4 → emr-core` is intrinsic to the wire-adapter pattern; the rule from `slices/CLAUDE.md` ("Slices should not depend on other slices unless the dependency is intrinsic to the feature") applies here and is satisfied. New cross-`emr/` deps should follow the same rationale and be documented here.

## Layering rules

- **`emr-core` is platform-neutral.** No DOM, no Node `fs`. (`@livestore/adapter-node` is a `devDependency` only — used in tests; not imported by source.)
- **`fhir-r4` is platform-neutral.** Same — the wire adapter doesn't reach for Node-specific globals. `page-token.ts` uses `Encoding` from `effect` rather than Node's `Buffer`.
- **Tests live alongside code** in both packages (`*.test.ts` next to the file they cover) plus an out-of-process suite in `fhir-r4/tests/`.

## Spec gap tracking

Places where `fhir-r4` deviates from, narrows, or postpones the FHIR R4 spec are catalogued in [`fhir-r4/docs/Capability Statement.md`](../fhir-r4/docs/Capability%20Statement.md). When you add a new gap, append an entry there.

## References

- [HttpApi Composition How-To](../../../docs/Effect/HttpApi%20Composition%20How-To.md) — phantom-id bridge between `emr-core` and `fhir-r4` API groups
- [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md)
- [Capability Statement](../fhir-r4/docs/Capability%20Statement.md)
