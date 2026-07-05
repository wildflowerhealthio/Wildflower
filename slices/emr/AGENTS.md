# AGENTS.md — slices/emr

FHIR R4 domain slice (Patient / Observation / Binary) backed by LiveStore, plus the FHIR wire adapter. Read the [Packages Explanation](./docs/Packages%20Explanation.md) before restructuring anything here.

## Guardrails

- **`fhir-r4` deliberately breaks the `-core` naming convention.** It is a wire-protocol package that never grows platform adapters, so it takes no suffix. The dependency arrow is `fhir-r4 → emr-core`, never the reverse. Don't "fix" the name and don't fold it into the version-agnostic `emr-core`.
- **Deviations from the FHIR R4 spec must be recorded** in the spec-gap catalogue at [fhir-r4/docs/Capability Statement.md](./fhir-r4/docs/Capability%20Statement.md) — append when you deviate, in the same change.

## Traps

- `@livestore/adapter-node` is a **devDependency only** (tests). Source must never import it — that would break `emr-core`'s platform neutrality.
- Per-resource persistence goes through the generic factory in `emr-core` (`domain-resource-persistence.ts`) — extend it rather than hand-rolling a parallel table/event/materializer set for a new resource.

## References

- [Packages Explanation](./docs/Packages%20Explanation.md) — why the packages split the way they do
- [emr-core README](./emr-core/README.md) — entry points and the persistence factory
