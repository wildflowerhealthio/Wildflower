# emr-rust FHIR R4 Capability Statement (server)

This describes the **server** — the running FHIR R4 endpoint mounted at `/fhir-r4`. That server is [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs) (HFS) embedded by `emr-rust` (see `src/lib.rs`); it opens a sqlite store and mounts HFS's Axum router at `/fhir-r4/*`.

**HFS's own `CapabilityStatement` is the source of truth for what the server supports.** HFS implements standard FHIR R4, and it publishes a live, machine-readable `CapabilityStatement` at `GET /fhir-r4/metadata` (unauthenticated). For "does the server support _X_?", read that resource or the [HFS project](https://github.com/HeliosSoftware/hfs) — do not re-catalogue standard FHIR R4 here.

This doc records only where `emr-rust` **diverges from, or adds to, stock HFS**: the handlers we mount ahead of HFS's router, the auth wiring, and the store limitations that change observable behaviour. When a divergence is fixed or a new one is introduced, amend this list in the same change.

> The **client** side — what the `fhir-r4` TypeScript `HttpApi`/schemas declare and validate — is catalogued separately in [`fhir-r4/docs/Client Capabilities Reference.md`](../../fhir-r4/docs/Client%20Capabilities%20Reference.md). There is no automated drift guard between the two; they are hand-synchronized.

## SMART App Launch discovery override

`GET /fhir-r4/.well-known/smart-configuration` is handled locally (`src/smart_configuration.rs`), mounted ahead of HFS with HFS's router as the fallback.

HFS's built-in discovery doc is shaped for **SMART Backend Services** — it advertises `client_credentials` with `token_endpoint_auth_methods_supported: ["private_key_jwt"]` only. Public **SMART App Launch** clients (e.g. the SMART growth-chart sample) need the `authorization_code` grant and an `authorization_endpoint`. Our override advertises the gatekeeper authorize/token URLs that already exist at the host root, so a SMART app fetches discovery here and follows the links straight to gatekeeper for the authorize/token exchange.

## `$everything` operation (added; Patient only)

`GET /fhir-r4/Patient/{id}/$everything` is implemented locally (`src/patient_everything.rs`), mounted ahead of HFS — **HFS ships no `$everything`**. It delegates data-fetching back into HFS's own handlers in-process (a `read` for the Patient, then an indexed `subject=` search per related type), re-driving a clone of HFS's router with sub-requests that carry the caller's `Authorization` header, so HFS's SMART v2 scope enforcement stays in the path exactly as for a direct `GET /Patient/{id}`.

Narrowings relative to spec FHIR `$everything`:

- **Patient only.** No `$everything` on other resource types; such a request falls through to HFS, which has no handler for it. (The `fhir-r4` client likewise declares `$everything` on Patient only — see the client doc.)
- **Related resources are the patient-referencing types in the `RELATED_RESOURCE_TYPES` table — `Observation`, `MedicationRequest` and `DiagnosticReport` today.** FHIR `$everything` returns every resource in the patient's compartment; we include only the types in that table (searched on their `subject` reference). Adding a type is a one-row change to the table — record it here in the same change.
- **Related-resource matching is server-side and fully paged.** HFS indexes `Observation.subject` / `MedicationRequest.subject` / `DiagnosticReport.subject` because the embedding now loads the full R4 `SearchParameter` set (see "SearchParameter index" below), so each related type is gathered with an indexed `GET /{Type}?subject=Patient/{id}` search that HFS filters, and the handler follows the search bundle's `next` cursor link to exhaustion. There is no in-memory `subject.reference` match and no single-page / store-wide candidate cap — a patient's related resources are returned in full regardless of how many the patient or the store holds. (`subject` is used rather than the `patient` search parameter because `subject` indexes a plain reference, whereas `patient`'s `.where(resolve() is Patient)` expression depends on `resolve()` at index time.)
- **Partial scope degrades gracefully.** A related-type search that fails (non-200 or an unreadable body) is logged and treated as _no matches_ rather than aborting; only the primary Patient read is fatal (its `401`/`403` propagates verbatim). A token that can read Patient + Observation but not MedicationRequest still gets a Bundle with the Patient and its Observations.
- **`_count` and `Bundle.total`.** `_count` truncates the combined matched related set (the primary Patient is always included on top); `Bundle.total` reflects the returned (post-truncation) entry count, not the grand match total.

## `GET /fhir-r4/api/dicom/files/{id}` (added; not a FHIR operation)

Implemented locally (`src/dicom_files.rs`), mounted ahead of HFS with the same in-process delegation shape as `$everything`: it delegates a `GET /DocumentReference/{id}` to HFS (so HFS's SMART v2 scope enforcement applies to the read exactly as for a direct request), then decodes the first `content[0].attachment.data` from base64 and returns it as the response body, with `Content-Type` taken from `attachment.contentType` (falling back to `application/octet-stream` when absent or not a valid header value).

This is not a FHIR resource or operation — it exists so a DICOM viewer (OHIF) can fetch a `dicom-importer-core`-stored source file's raw bytes by id over plain HTTP, rather than parsing base64 out of FHIR JSON itself. A non-`200` from the delegated `DocumentReference` read propagates verbatim (e.g. `404` for a missing document, `401`/`403` for a lacking scope); a `200` `DocumentReference` with no content entry or no attachment `data` yields a `404` OperationOutcome of its own.

## `SearchParameter` index (full R4 set, indexed at write time)

`emr-rust` loads the **complete HL7 FHIR R4 `SearchParameter` bundle** into HFS. HFS's SQLite backend registers SearchParameters from a filesystem `data_dir`; the R4 `search-parameters.json` ships as a **deployed asset** (see `assets/README.md`) — a bundled resource, not embedded in the binary — and the host points `EmrConfig::search_parameter_data_dir` at the directory holding it, which `setup_fhir_r4` passes to the backend via `SqliteBackendConfig { data_dir: Some(...) }` (`src/lib.rs`). HFS reads it read-only and extracts and indexes every standard R4 search parameter for a resource **at write time**. `setup_fhir_r4` fails fast if the bundle is missing from that directory, rather than silently falling back to the minimal index.

Consequences:

- Standard type-level and compartment searches resolve server-side: `Observation` by `subject`/`patient`/`code`/`category`/`date`/`status`, `Patient` by `name`/`identifier`/`birthdate`, and so on for every stored type.
- This is what lets `$everything` (above) delegate an indexed `subject=` search instead of matching in memory.

Two limits worth noting:

- **Write-time indexing / no automatic reindex.** HFS indexes on create/update, so only resources written **after** the SearchParameter set is in place are searchable. This embedding is local-first and pre-release with no production stores, so we rely on the **fresh-store assumption**: existing dev stores predate any real data and are recreated, so no one-time backfill is shipped. HFS does expose a `$reindex`/`ReindexOperation` if a backfill is ever needed for an existing store.
- **`data_dir: None` is no longer used.** The historical narrowing where the backend opened with `data_dir: None` (only a ~9-parameter `_id`/`_lastUpdated` fallback index, so `subject`/`name`/`code`/compartment searches returned nothing) no longer applies.

## Auth is off unless a JWKS URL is configured

When `EmrConfig::jwks_url` is `Some`, HFS auth is enabled: it validates the bearer JWT against the configured JWKS, enforces `iss`, parses SMART v2 scopes, and gates each FHIR operation against them (against gatekeeper's JWKS in the app). When it is `None`, the FHIR surface is unauthenticated.

Either way, a fixed set of discovery/health paths stays unauthenticated per the SMART spec (`UNAUTHENTICATED_FHIR_PATHS` in `src/lib.rs`): `/metadata`, `/.well-known/smart-configuration`, `/$versions`, `/health`, `/_liveness`, `/_readiness`.

## Token revocation on the FHIR path (a custom `JtiCache`)

When auth is on, HFS also consults a custom `helios_auth::JtiCache` — `RevocationJtiCache` in `src/auth.rs` — once per validated token that carries a `jti`. Unlike helios's stock `memory` backend, it is **not** a single-use nonce cache (that would `401` every FHIR request after the first, since a gatekeeper access token is a multi-use bearer reused across many FHIR calls). It reports a "replay" **iff** the token's `jti` is on the shared revocation denylist (`token-revocation-rust`), and it never stores. This is the FHIR-side, per-`jti` half of token revocation (#269); the per-subject _epoch_ half needs `sub`/`iat`, which helios doesn't hand the cache, and is enforced by gatekeeper's bearer gate, which fronts every `/fhir-r4/*` request and runs first. A store read failure fails closed (HFS `InternalError` → the request is rejected, never admitted). Both enforcement points read the one store the host builds on the shared database.
