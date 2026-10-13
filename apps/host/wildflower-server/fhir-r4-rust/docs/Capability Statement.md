# fhir-r4-rust FHIR R4 Capability Statement (server)

This describes the **server** — the running FHIR R4 endpoint served at the server's root, so its FHIR base is its origin. That server is [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs) (HFS) embedded by `fhir-r4-rust` (see `src/lib.rs`); it opens a sqlite store and serves HFS's Axum router at the root.

**HFS's own `CapabilityStatement` is the source of truth for what the server supports.** HFS implements standard FHIR R4, and it publishes a live, machine-readable `CapabilityStatement` at `GET /metadata` (unauthenticated). For "does the server support _X_?", read that resource or the [HFS project](https://github.com/HeliosSoftware/hfs) — do not re-catalogue standard FHIR R4 here.

This doc records only where `fhir-r4-rust` **diverges from, or adds to, stock HFS**: the handlers we mount ahead of HFS's router, the auth wiring, and the store limitations that change observable behaviour. When a divergence is fixed or a new one is introduced, amend this list in the same change.

> The **client** side — what the `fhir-r4` TypeScript `HttpApi`/schemas declare and validate — is catalogued separately in [`fhir-r4/docs/Client Capabilities Reference.md`](../../../../../slices/fhir/fhir-r4/docs/Client%20Capabilities%20Reference.md). There is no automated drift guard between the two; they are hand-synchronized.

## Served at the root, on FHIR paths only

The FHIR API shares the server's root with the other slices (`/oauth`, `/apps`, `/health`, …). HFS answers through a fallback rather than a fixed set of routes, so the host can't merge it in beside them: `wildflower-server-rust`'s `root_fallback` sends a request no slice route claims to the (bearer-gated) FHIR router only when `is_fhir_r4_route` says it is FHIR's, and gives every other path the host's own `404`. FHIR's are: `POST /` (a batch or transaction at the base; a `GET /` is someone opening the server), a path under an R4 resource type (case-sensitive, from `helios_rest::fhir_types`), a system-level `$operation`, the web UI (`ui`) and its per-user settings (`_user`), `metadata`, `_history`, `_search`, `_liveness`, `_readiness`, HFS's bulk-data (`export*`, `bulk-submit-*`), admin (`admin`), console (`console`) and subscription (`ws`) surfaces, and the `.well-known/smart-configuration` and `.well-known/bulk-submit-jwks.json` documents. HFS's own `/health` is never reached: the host serves `/health` itself.

## Web UI (`/ui`) and its sign-in

HFS's web UI (`helios-ui`) is mounted at `/ui`, with its interactive login installed. The UI is a SMART client of this server's authorization server: `/ui/login` sends the browser to the authorization server's `/oauth/authorize` on the public origin with PKCE, as a public client the host seeds on every boot (a random client id, named "FHIR server UI", whose one redirect URI is `{public_origin}/ui/callback`, allowed `user/*.cruds`). The Owner approves the first sign-in like any other client's. `/ui/callback` redeems the code at the authorization server's token endpoint on loopback, keeps the tokens server-side and gives the browser an `HttpOnly` `hfs_session` cookie. Sessions live in memory: a restart signs the user out. The authorization server has no OpenID Connect, so a session's identity is its access token's `sub`, the UI's client id.

The UI's pages pass the host's bearer gate; HFS itself sends a visitor without a session to `/ui/login`. The pages' FHIR calls carry only the cookie, so `wildflower-server-rust`'s `ui_session_bearer` middleware, in front of both the UI's routes and the gate, presents the session's access token as `Authorization: Bearer` for a request from the served origin with no `Authorization` of its own, and the gate and HFS check it like any other token. A request is from the served origin when every header the browser sent agrees: `Sec-Fetch-Site` is `same-origin` or `none`, and `Origin` is the served origin; a write (any method but `GET`, `HEAD`, `OPTIONS`, `TRACE`) must send `Origin`. A write carrying the cookie from anywhere else is refused `403`, since the UI's own routes sit outside the gate and act as the session's user on the cookie alone; a read from elsewhere passes without the bearer, so a link into `/ui` still opens. Same-site is not enough: every server is a subdomain of its relay's domain, under `wildflowerhealth.io`, and neither is a public suffix, so another server behind the same relay, or a page on `wildflowerhealth.io`, is same-site, and its form posts carry the `SameSite=Lax` cookie. The UI's conformance pages call the FHIR API on the public origin, never loopback, so they never run on the host owner's loopback trust. A browser opening the server's root (`GET /` asking for HTML) is sent to `/ui`.

The UI's per-user settings (`/_user/settings`: theme, saved and recent queries, …) are stored in the health data's own sqlite file, in HFS's `user_settings` table, so they survive a restart and go wherever the health data goes. HFS keys them by the caller's token `iss` and `sub`. Since a session's `sub` is the UI's client id, everyone who signs in to one server's UI shares one settings document. The UI also tracks its bulk export jobs in that document; without a settings store it turns its bulk export and import pages off.

## Bulk `$export` (run in-process)

The system, Patient and Group `$export` operations are served, with HFS's default settings (a 24-hour output TTL, at most 4 jobs in flight per tenant). helios-rest only accepts and tracks jobs, so the embedding runs the rest itself: `fhir-r4-rust`'s `BulkExportWorker`, which `WildflowerServer::serve` runs until its shutdown, claims one job at a time and runs it, and every 5 minutes deletes the record and files of each job whose output has outlived the TTL. A shutdown hands a running job back, so the next start runs it again. The job records live in the health data's sqlite file. Each job's NDJSON files are staged under the server's `fhir-exports` folder (`{tenant}/{job_id}/`), and a client only ever gets them by downloading them from HFS's `/export-file` route on the public origin. That route takes the bearer that kicked the export off, and HFS allows the download to the job's owner (or a `system/*` scope) holding read on the file's resource type. Bulk submit (`$bulk-submit`) is not wired.

## SMART App Launch discovery override

`GET /.well-known/smart-configuration` is handled locally (`src/smart_configuration.rs`), mounted ahead of HFS with HFS's router as the fallback.

HFS's built-in discovery doc is shaped for **SMART Backend Services** — it advertises `client_credentials` with `token_endpoint_auth_methods_supported: ["private_key_jwt"]` only. Public **SMART App Launch** clients (e.g. the SMART growth-chart sample) need the `authorization_code` grant and an `authorization_endpoint`. Our override advertises the authorization server authorize/token URLs that already exist at the host root, so a SMART app fetches discovery here and follows the links straight to the authorization server for the authorize/token exchange. Its `capabilities` also list `wildflower-server`, which is how a client (`authorization-core`'s discovery) tells a Wildflower server from a plain SMART server answering at the same kind of URL.

The document advertises only what is served. Every endpoint URL in it is a route on the origin it was served on (`wildflower-server-rust`'s `every_endpoint_smart_discovery_advertises_is_routed` walks them), except `management_endpoint`:

- **`management_endpoint`** is the hosted Wildflower Authorization app, pointed at this server: `<AuthorizationAppBase>?iss=<issuer>`. The host sets the base (`authorization_app_base_url` in `tauri-shared-config.json`, `https://wildflowerhealth.io/authorization/`).
- **`wildflower_authorization_api`**, a Wildflower extension field, is the authorization server's JSON API base, `<origin>/authorization/`. The app reads it, so it never hardcodes a server path.
- **`grant_types_supported`** and **`token_endpoint_auth_methods_supported`** are what `/oauth/token` accepts: the `authorization_code`, `refresh_token` and device-code grants; a client secret in a Basic header or the form body, or `none` for a public client.
- There is no `registration_endpoint`, `revocation_endpoint` or `introspection_endpoint`: none is served. `/authorization/revocations` takes `{jti, expiresAt}` or `{subject}`, not RFC 7009's `token`, so it isn't advertised as one.

## `$everything` operation (added; Patient only)

`GET /Patient/{id}/$everything` is implemented locally (`src/patient_everything.rs`), mounted ahead of HFS — **HFS ships no `$everything`**. It delegates data-fetching back into HFS's own handlers in-process (a `read` for the Patient, then an indexed `subject=` search per related type), re-driving a clone of HFS's router with sub-requests that carry the caller's `Authorization` header, so HFS's SMART v2 scope enforcement stays in the path exactly as for a direct `GET /Patient/{id}`.

Narrowings relative to spec FHIR `$everything`:

- **Patient only.** No `$everything` on other resource types; such a request falls through to HFS, which has no handler for it. (The `fhir-r4` client likewise declares `$everything` on Patient only — see the client doc.)
- **Related resources are the patient-referencing types in the `RELATED_RESOURCE_TYPES` table — `Observation`, `MedicationRequest` and `DiagnosticReport` today.** FHIR `$everything` returns every resource in the patient's compartment; we include only the types in that table (searched on their `subject` reference). Adding a type is a one-row change to the table — record it here in the same change.
- **Related-resource matching is server-side and fully paged.** HFS indexes `Observation.subject` / `MedicationRequest.subject` / `DiagnosticReport.subject` because the embedding now loads the full R4 `SearchParameter` set (see "SearchParameter index" below), so each related type is gathered with an indexed `GET /{Type}?subject=Patient/{id}` search that HFS filters, and the handler follows the search bundle's `next` cursor link to exhaustion. There is no in-memory `subject.reference` match and no single-page / store-wide candidate cap — a patient's related resources are returned in full regardless of how many the patient or the store holds. (`subject` is used rather than the `patient` search parameter because `subject` indexes a plain reference, whereas `patient`'s `.where(resolve() is Patient)` expression depends on `resolve()` at index time.)
- **Partial scope degrades gracefully.** A related-type search that fails (non-200 or an unreadable body) is logged and treated as _no matches_ rather than aborting; only the primary Patient read is fatal (its `401`/`403` propagates verbatim). A token that can read Patient + Observation but not MedicationRequest still gets a Bundle with the Patient and its Observations.
- **`_count` and `Bundle.total`.** `_count` truncates the combined matched related set (the primary Patient is always included on top); `Bundle.total` reflects the returned (post-truncation) entry count, not the grand match total.

## `base_url` (the public origin, for every caller)

HFS's `base_url` is the prefix of every URL it emits: search Bundle `self`/`next` links, `entry.fullUrl`, and a create's `Location`. It is the bare `public_origin`, from `FhirR4Config::public_origin`, set once when `setup_fhir_r4` builds HFS's router.

Consequence: **`base_url` is the same for every caller, not the origin the request arrived at.** A request served on loopback gets links on the public origin. The `$everything` and SMART discovery overrides above are different: they render the served origin per request.

## `SearchParameter` index (full R4 set, indexed at write time)

`fhir-r4-rust` loads the **complete HL7 FHIR R4 `SearchParameter` bundle** into HFS. HFS's SQLite backend registers SearchParameters from a filesystem `data_dir`; the R4 `search-parameters.json` ships as a **deployed asset** (see `assets/README.md`) — a bundled resource, not embedded in the binary — and the host points `FhirR4Config::search_parameter_data_dir` at the directory holding it, which `setup_fhir_r4` passes to the backend via `SqliteBackendConfig { data_dir: Some(...) }` (`src/lib.rs`). HFS reads it read-only and extracts and indexes every standard R4 search parameter for a resource **at write time**. `setup_fhir_r4` fails fast if the bundle is missing from that directory, rather than silently falling back to the minimal index.

Consequences:

- Standard type-level and compartment searches resolve server-side: `Observation` by `subject`/`patient`/`code`/`category`/`date`/`status`, `Patient` by `name`/`identifier`/`birthdate`, and so on for every stored type.
- This is what lets `$everything` (above) delegate an indexed `subject=` search instead of matching in memory.

Two limits worth noting:

- **Write-time indexing / no automatic reindex.** HFS indexes on create/update, so only resources written **after** the SearchParameter set is in place are searchable. This embedding is local-first and pre-release with no production stores, so we rely on the **fresh-store assumption**: existing dev stores predate any real data and are recreated, so no one-time backfill is shipped. HFS does expose a `$reindex`/`ReindexOperation` if a backfill is ever needed for an existing store.
- **`data_dir: None` is no longer used.** The historical narrowing where the backend opened with `data_dir: None` (only a ~9-parameter `_id`/`_lastUpdated` fallback index, so `subject`/`name`/`code`/compartment searches returned nothing) no longer applies.

## Auth is off unless a JWKS URL is configured

When `FhirR4Config::jwks_url` is `Some`, HFS auth is enabled: it validates the bearer JWT against the configured JWKS, requires its `iss` and `aud` to be the server's origin (`FhirR4Config::public_origin`), parses SMART v2 scopes, and gates each FHIR operation against them (against the authorization server's JWKS in the app). When it is `None`, the FHIR surface is unauthenticated.

Either way, a fixed set of discovery/health paths stays unauthenticated per the SMART spec (`UNAUTHENTICATED_FHIR_PATHS` in `src/lib.rs`): `/metadata`, `/.well-known/smart-configuration`, `/$versions`, `/health`, `/_liveness`, `/_readiness`.

## Token revocation on the FHIR path (a revocation-checking `AuthProvider`)

When auth is on, HFS authenticates through `RevocationCheckingProvider` in `src/auth.rs` — a `helios_auth::AuthProvider` that wraps helios's `JwksBearerAuthProvider` and, once the token validates, checks its `jti` (`Principal::jti`) against the shared revocation denylist (`token-revocation-rust`). It rejects the token **iff** its `jti` is on the denylist, and it never stores — it is **not** a single-use nonce cache (that would `401` every FHIR request after the first, since an authorization server access token is a multi-use bearer reused across many FHIR calls). helios keeps no revocation hook of its own, hence the wrapper. This is the FHIR-side, per-`jti` half of token revocation (#269); the per-subject _epoch_ half needs `iat`, which helios's `Principal` doesn't carry, and is enforced by the authorization server's bearer gate, which fronts every FHIR request and runs first. A store read failure fails closed (`AuthError::InternalError` → the request is rejected, never admitted). Both enforcement points read the one store the host builds on the shared database.
