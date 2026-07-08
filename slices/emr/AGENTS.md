# AGENTS.md — slices/emr

FHIR R4 slice: pure wire schemas (Patient / Observation / Binary), the `HttpApi` description, and the HTTP client for the off-the-shelf HFS FHIR server embedded by `emr-rust`. Read the [Packages Explanation](./docs/Packages%20Explanation.md) before restructuring anything here.

## Guardrails

- **The server is HFS, not TypeScript.** `emr-rust` embeds the HeliosSoftware/hfs crates and is mounted at `/fhir-r4` by `apps/wildflower-tauri`. There is no TS server implementation; `fhir-r4` is a description + schemas + client only. Don't add server handlers back to the TS side.
- **`fhir-r4` deliberately breaks the `-core` naming convention.** It is a wire-protocol package that never grows platform adapters, so it takes no suffix. It depends on no other emr package.
- **Deviations from the FHIR R4 spec must be recorded** in the spec-gap catalogue at [fhir-r4/docs/Capability Statement.md](./fhir-r4/docs/Capability%20Statement.md) — append when you deviate, in the same change.

## Traps

- **No drift guard exists between `fhir-r4`'s `HttpApi` and HFS's actual surface.** Unlike other slices there is no OpenAPI snapshot pair; the two sides are hand-synchronized. If you change the `HttpApi` definition, verify HFS actually serves that shape (see the Capability Statement).
- Complex datatypes self-register into the registry at module load (`registerDatatypeSchema` at the bottom of each datatype file). A `value[x]` slot whose datatype module hasn't been imported fails encode with `UnregisteredDatatype` — keep the side-effect imports (e.g. in `observation.ts`) intact.

## References

- [Packages Explanation](./docs/Packages%20Explanation.md) — why the packages split the way they do
- [Capability Statement](./fhir-r4/docs/Capability%20Statement.md) — spec-gap catalogue
