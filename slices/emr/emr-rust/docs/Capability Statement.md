# emr-rust FHIR R4 Capability Statement (server)

This describes the **server** — the running FHIR R4 endpoint mounted at `/fhir-r4`. That server is [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs) (HFS) embedded by `emr-rust` (see `src/lib.rs`); it opens a sqlite store and mounts HFS's Axum router at `/fhir-r4/*`.

**HFS's own `CapabilityStatement` is the source of truth for what the server supports.** HFS implements standard FHIR R4, and it publishes a live, machine-readable `CapabilityStatement` at `GET /fhir-r4/metadata` (unauthenticated). For "does the server support _X_?", read that resource or the [HFS project](https://github.com/HeliosSoftware/hfs) — do not re-catalogue standard FHIR R4 here.

This doc records only where `emr-rust` **diverges from, or adds to, stock HFS**: the handlers we mount ahead of HFS's router, the auth wiring, and the store limitations that change observable behaviour. When a divergence is fixed or a new one is introduced, amend this list in the same change.

> The **client** side — what the `fhir-r4` TypeScript `HttpApi`/schemas declare and validate — is catalogued separately in [`fhir-r4/docs/Client Capabilities Reference.md`](../../fhir-r4/docs/Client%20Capabilities%20Reference.md). There is no automated drift guard between the two; they are hand-synchronized.

## SMART App Launch discovery override

`GET /fhir-r4/.well-known/smart-configuration` is handled locally (`src/smart_configuration.rs`), mounted ahead of HFS with HFS's router as the fallback.

HFS's built-in discovery doc is shaped for **SMART Backend Services** — it advertises `client_credentials` with `token_endpoint_auth_methods_supported: ["private_key_jwt"]` only. Public **SMART App Launch** clients (e.g. the SMART growth-chart sample) need the `authorization_code` grant and an `authorization_endpoint`. Our override advertises the gatekeeper authorize/token URLs that already exist at the host root, so a SMART app fetches discovery here and follows the links straight to gatekeeper for the authorize/token exchange.

## `$everything` operation (added; Patient only)

`GET /fhir-r4/Patient/{id}/$everything` is implemented locally (`src/patient_everything.rs`), mounted ahead of HFS — **HFS ships no `$everything`**. It delegates data-fetching back into HFS's own handlers in-process (a `read` for the Patient, then a type-level search per related type), re-driving a clone of HFS's router with sub-requests that carry the caller's `Authorization` header, so HFS's SMART v2 scope enforcement stays in the path exactly as for a direct `GET /Patient/{id}`.

Narrowings relative to spec FHIR `$everything`:

- **Patient only.** No `$everything` on other resource types; such a request falls through to HFS, which has no handler for it. (The `fhir-r4` client nonetheless _declares_ `$everything` on every resource group — see the client doc.)
- **Related resources are the patient-referencing types in the `RELATED_RESOURCE_TYPES` table — `Observation` and `MedicationRequest` today.** FHIR `$everything` returns every resource in the patient's compartment; we include only the types in that table (matched on their `subject` reference). Adding a type is a one-row change to the table — record it here in the same change.
- **Related-resource matching is in-memory, over a single search page per type.** The embedding ships no FHIR `SearchParameter` spec files (the backend opens with `data_dir: None`), so `Observation.subject` isn't indexed and a compartment/`subject=` search returns nothing. Instead we run each type's _type-level_ search — capped at `RELATED_FETCH_LIMIT` (1000, HFS's `max_page_size`) — and filter `subject.reference == "Patient/{id}"` in memory. Only the first page is inspected, and the search is store-wide (not compartment-scoped), so once the store holds more than 1000 of a type across **all** patients, a target patient's rows outside that page are silently dropped — even a patient with only a handful. Closing this needs the delegated search paged to exhaustion, or a real `subject`-indexed compartment search.
- **Partial scope degrades gracefully.** A related-type search that fails (non-200 or an unreadable body) is logged and treated as _no matches_ rather than aborting; only the primary Patient read is fatal (its `401`/`403` propagates verbatim). A token that can read Patient + Observation but not MedicationRequest still gets a Bundle with the Patient and its Observations.
- **`_count` and `Bundle.total`.** `_count` truncates the combined matched related set (the primary Patient is always included on top); `Bundle.total` reflects the returned (post-truncation) entry count, not the grand match total.

## No `SearchParameter` index (search is `_id`/`_lastUpdated` only)

Because the embedding opens with `data_dir: None`, HFS loads no `SearchParameter` spec files: only a minimal `_id`/`_lastUpdated` index exists. Searches keyed on any other parameter — `name`, `identifier`, `subject`, `code`, `category`, `patient`, compartment searches — return nothing at the server, regardless of what a client asks for. This is why `$everything` matches related resources in memory (above).

## Auth is off unless a JWKS URL is configured

When `EmrConfig::jwks_url` is `Some`, HFS auth is enabled: it validates the bearer JWT against the configured JWKS, enforces `iss`, parses SMART v2 scopes, and gates each FHIR operation against them (against gatekeeper's JWKS in the app). When it is `None`, the FHIR surface is unauthenticated.

Either way, a fixed set of discovery/health paths stays unauthenticated per the SMART spec (`UNAUTHENTICATED_FHIR_PATHS` in `src/lib.rs`): `/metadata`, `/.well-known/smart-configuration`, `/$versions`, `/health`, `/_liveness`, `/_readiness`.
