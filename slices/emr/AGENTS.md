# AGENTS.md — slices/emr

FHIR R4 slice: pure wire schemas (Patient / Observation / Binary), the `HttpApi` description, and the HTTP client for the off-the-shelf HFS FHIR server embedded by `emr-rust`. Read the [Packages Explanation](./docs/Packages%20Explanation.md) before restructuring anything here.

## Guardrails

- **The server is HFS, not TypeScript.** `emr-rust` embeds the HeliosSoftware/hfs crates and is mounted at `/fhir-r4` by `apps/wildflower-tauri`. There is no TS server implementation; `fhir-r4` is a description + schemas + client only. Don't add server handlers back to the TS side.
- **`fhir-r4` deliberately breaks the `-core` naming convention.** It is a wire-protocol package that never grows platform adapters, so it takes no suffix. It depends on no other emr package.
- **`fhir-r4/clients` owns writing to the store, one resource (`upsertResource`) and one batch (`makePersistResources`) at a time.** The batch sink lives here rather than in the collector slice because it needs `upsertResource` and the typed client, while `collector-fundamentals` is deliberately FHIR-agnostic — it was three duplicated copies across `*-client-collector` packages before it was consolidated. It must stay free of any consumer's vocabulary: span names and the log label are **supplied by the caller**, and its `ResourceWriteFailure` is declared here rather than imported, because this slice sits below its consumers and cannot name them. A consumer checks the two against each other at its own call site.
- **Deviations from the FHIR R4 spec must be recorded, in the catalogue for the side you touched, in the same change.** Client-side (TS schemas / `HttpApi`) go in [fhir-r4/docs/Client Capabilities Reference.md](./fhir-r4/docs/Client%20Capabilities%20Reference.md); server-side (`emr-rust`'s overrides on top of HFS) go in [emr-rust/docs/Capability Statement.md](./emr-rust/docs/Capability%20Statement.md).

## Traps

- **No drift guard exists between `fhir-r4`'s `HttpApi` and HFS's actual surface.** A snapshot pair does exist (`emr-rust/openapi/fhir-r4.openapi.json`, generated from the TS `fhir-r4` `HttpApi` and kept fresh by a TS-side test, and read on the Rust side by `emr_rust::openapi_spec` for the host's unified `/docs` page) — but it only guards the snapshot against the `HttpApi`, not against what HFS actually serves. If you change the `HttpApi` definition, verify HFS actually serves that shape (see the Client Capabilities Reference).
- Complex datatypes self-register into the registry at module load (`registerDatatypeSchema` at the bottom of each datatype file). A `value[x]` slot whose datatype module hasn't been imported fails encode with `UnregisteredDatatype`. Import the registration barrel `fhir-r4/src/data-types/register-all.ts` (one side-effect import that loads every registrable module) instead of hand-listing modules per resource. `register-all.test.ts` asserts the barrel populates every registry slot, so a dropped or forgotten registration is a CI failure rather than a latent runtime one — but the barrel's imports are still bare side effects, so add the matching line whenever a new complex datatype module lands.

## References

- [Packages Explanation](./docs/Packages%20Explanation.md) — why the packages split the way they do
- [Client Capabilities Reference](./fhir-r4/docs/Client%20Capabilities%20Reference.md) — client-side (TS) gap catalogue
- [emr-rust Capability Statement](./emr-rust/docs/Capability%20Statement.md) — server-side (HFS embedding) deltas from stock HFS
