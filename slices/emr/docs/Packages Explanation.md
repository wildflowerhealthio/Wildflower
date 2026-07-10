# slices/emr/ Packages Explanation

EMR domain — the FHIR R4 wire surface for patient/observation/binary resources. The server is the off-the-shelf [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs) FHIR server, embedded by the slice's Rust crate; the TypeScript packages describe the wire protocol and consume it.

- **`fhir-r4`** — standalone FHIR R4 package: pure Effect schemas for datatypes and resources (`data-types/`, `resources/`), the `HttpApi` description of the FHIR REST surface (`http-api-definition/`, prefix `/fhir-r4`), and the derived HTTP client (`clients/`). No server implementation, no persistence — the decoded type of every schema is a plain FHIR R4 value.
- **`fhir-r4-react`** — React adapter: the tokenless client runtime layer (`FhirR4ResourcesRouterContext`) and query hooks (`usePatientsQuery`). Documented cross-slice consumers: `collector-react`'s sync runner and `gatekeeper-react`'s consent-screen patient picker.
- **`emr-rust`** — the production FHIR server host. Embeds HFS (`helios-rest`/`helios-persistence`/`helios-auth`, pinned `=0.2.x`) over SQLite, and overrides `/fhir-r4/.well-known/smart-configuration` with a SMART App Launch-shaped discovery doc pointed at gatekeeper's OAuth endpoints. Mounted and auth-gated by `apps/wildflower-tauri` at `/fhir-r4` (see `FHIR_R4_PATH` and `UNAUTHENTICATED_FHIR_PATHS` in `emr-rust/src/lib.rs`).

## History: where `emr-core` went

The slice used to carry `emr-core`, a LiveStore-backed domain layer (tables, events, materializers, row schemas) that acted as a JS-hosted EMR server, with `fhir-r4` as a wire adapter mapping FHIR JSON onto those rows and implementing the HTTP handlers in TS. When the server moved to HFS/Rust, that whole layer became dead code: `emr-core` was deleted, the TS `http-api-implementation` and its LiveStore-backed integration/profile suites were removed, and `fhir-r4`'s schemas were collapsed into single pure FHIR R4 schemas (the decoded type is the FHIR value itself, not a store row).

## Layering rules

- **`fhir-r4` is platform-neutral.** No DOM, no Node `fs`, no store bindings.
- **`fhir-r4` depends on no other emr package.** `fhir-r4-react` depends only on `fhir-r4`. `emr-rust` shares no code with the TS packages — the wire format is the contract.
- **Tests live alongside code** (`*.test.ts` next to the file they cover). They are pure schema round-trip/property tests; server behaviour is HFS's responsibility (HFS has its own test suite upstream).

## Contract with the server (no automated drift guard)

Unlike other slices there is **no** OpenAPI-snapshot drift pair between the TS `HttpApi` definition and the Rust server, because `emr-rust` mounts HFS's router wholesale rather than hand-authoring `utoipa` routes. The `HttpApi` describes the standard FHIR R4 REST subset the app uses; HFS implements standard FHIR R4. If either side changes, sync is manual — see the [Client Capabilities Reference](../fhir-r4/docs/Client%20Capabilities%20Reference.md) for the catalogued client-side gaps.

## References

- [Client Capabilities Reference](../fhir-r4/docs/Client%20Capabilities%20Reference.md)
- [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md)
