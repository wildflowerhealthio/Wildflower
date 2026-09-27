//! First-boot seeding for the gatekeeper store: the signing key and the
//! first-party host client. Safe to call on every boot — the signing key is
//! inserted only when none exists (never rotated), and the first-party client is
//! *ensured* (re-applied as an upsert) so its definition always matches the
//! host's granted scopes, correcting any drift in a store created by an older
//! build.
//!
//! The bundled SMART sample-app clients (growth-chart, medication-viewer →
//! `my_web_app`, PRECISE-HBR) are seeded in SQL instead — migration
//! `0003_seed_sample_clients` — since they're static definitions a migration
//! can express. Only the runtime-derived seeds (the first-party client's scopes,
//! the generated signing key) stay here.

use anyhow::Context;
use chrono::{Duration, Utc};
use persistence_rust::DieselPool;

use crate::db::SqliteGatekeeperStore;
use crate::domain::authority::{HostOwnerEntitlement, TokenEntitlement};
use crate::domain::capabilities::writers::AccessTokenMinter;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::TokenIssuanceError;
// The persistence port trait — brought into scope so the store's methods
// (`active_signing_key`, `insert_signing_key`, `upsert_client`, …) resolve on
// the concrete `SqliteGatekeeperStore` this boot code holds directly.
use crate::domain::GatekeeperStore as _;

/// Wrap the host-owned connection `pool` in a gatekeeper store (applying
/// migrations, which includes the SQL seed of the SMART sample-app clients)
/// and run the runtime-derived first-boot seeding steps — the signing key and
/// the first-party host client. Safe to call on every boot.
///
/// # Errors
///
/// Returns an error if the store cannot be created (migrations) or if any seeding
/// step fails.
pub fn open_and_seed_store(
    pool: DieselPool,
    host_owner_scopes: &[String],
    first_party_client_id: &str,
) -> anyhow::Result<SqliteGatekeeperStore> {
    let store = SqliteGatekeeperStore::new(pool).context("failed to open gatekeeper store")?;
    ensure_some_active_signing_key(&store).context("failed to seed signing key")?;
    ensure_first_party_client(&store, host_owner_scopes, first_party_client_id)
        .context("failed to seed first-party client")?;
    Ok(store)
}

/// Generate and insert an active signing key if the table is empty;
/// otherwise leave the existing keys alone. Idempotent — safe to call on
/// every boot.
fn ensure_some_active_signing_key(store: &SqliteGatekeeperStore) -> anyhow::Result<()> {
    let existing = store.active_signing_key().context("read signing keys")?;
    if existing.is_some() {
        return Ok(());
    }
    let mut key = SigningKey::generate().context("generate signing key")?;
    key.is_active = true;
    store
        .insert_signing_key(&key)
        .context("insert signing key")?;
    Ok(())
}

/// Ensure the first-party host client matches the code's definition. Upserted on
/// every boot so its `allowed_scopes` (and the rest of its policy) always match
/// the host's `host_owner_scopes`, and its `client_id` matches
/// `first_party_client_id` (the live app sources both from
/// `tauri-shared-config.json`; see [`crate::default_local_granted_scopes`] /
/// [`crate::default_first_party_client_id`]), correcting a store seeded by an
/// older build (registration time and any admin disable are preserved).
fn ensure_first_party_client(
    store: &SqliteGatekeeperStore,
    host_owner_scopes: &[String],
    first_party_client_id: &str,
) -> anyhow::Result<()> {
    let client = Client {
        client_id: first_party_client_id.to_string(),
        name: "Wildflower (host)".to_string(),
        kind: ClientKind::Public,
        redirect_uris: vec![],
        allowed_scopes: host_owner_scopes.to_vec(),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .upsert_client(&client)
        .context("seed first-party client")?;
    Ok(())
}

/// The shared dev-port file, embedded at compile time — the single source of
/// truth for the first-party apps' vite dev-server ports across the TS ⇄ Rust
/// boundary. `apps-rust`'s `dev_seed.rs` embeds this same file to seed the
/// matching `<app>-dev` app rows, and each app's `vite.config.ts` reads it for
/// `server.port` (+ `strictPort`), so a client's loopback redirect below points
/// at exactly the port the row and the dev server agree on. A literal here would
/// let that redirect silently drift off the shared value.
#[cfg(debug_assertions)]
const DEV_APP_PORTS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/dev-app-ports.json"
));

/// The subset of [`DEV_APP_PORTS_JSON`] this seed needs — the seven first-party
/// apps that register an OAuth client. The file also carries `web-server-docs-dev`,
/// which is not a SMART app and so has no client here; serde ignores it.
#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
struct DevAppPorts {
    #[serde(rename = "medications-app-dev")]
    medications_app_dev: u16,
    #[serde(rename = "web-trace-app-dev")]
    web_trace_app_dev: u16,
    #[serde(rename = "importer-app-dev")]
    importer_app_dev: u16,
    #[serde(rename = "ohif-viewer-dev")]
    ohif_viewer_dev: u16,
    #[serde(rename = "fhir-sync-pebble-dev")]
    fhir_sync_pebble_dev: u16,
    #[serde(rename = "health-viewer-app-dev")]
    health_viewer_app_dev: u16,
    #[serde(rename = "lifting-app-dev")]
    lifting_app_dev: u16,
}

/// The `health-viewer-app-dev` client's scopes: exactly the scope string in
/// `apps/health-viewer/src/config.ts`, which requests the same set for an EHR
/// launch and a standalone connect. A test below reads that file and pins the
/// two together, so a scope added on one side alone fails the test rather than
/// `/authorize` on a real device.
#[cfg(debug_assertions)]
const HEALTH_VIEWER_DEV_SCOPES: &[&str] = &[
    "launch",
    "launch/patient",
    "openid",
    "fhirUser",
    "system/Observation.rs",
    "system/MedicationRequest.rs",
    "system/Patient.rs",
];

/// The loopback redirect route for a dev app served at its origin root — every
/// first-party app but the OHIF viewer, whose launch targets a sub-route.
#[cfg(debug_assertions)]
const DEV_ROOT_REDIRECT_PATH: &str = "/";

/// The debug-only OAuth clients for the first-party apps' vite dev servers — the
/// gatekeeper half of `apps_rust::seed_dev_apps`.
///
/// The first-party SMART apps (Medications, Web Trace, Importer, the OHIF
/// imaging viewer, Lifting) ship as **cloud** rows served from
/// <https://wildflowerhealth.io> (apps migrations `0005_first_party_apps_to_cloud`
/// onward), whose clients register an *absolute* Pages redirect URI. A debug
/// build also gets a cloud `<app>-dev` row (`apps_rust::dev_seed`) whose launch
/// URL points at the app's local vite dev server on the port
/// `dev-app-ports.json` pins, and that row needs its own client whose id equals
/// the dev app id and whose absolute `http://localhost:{port}` redirect is what
/// the authorize flow matches. They are separate clients rather than extra
/// redirect entries on the production ones because adding a plaintext loopback
/// redirect there would register it on a client that a public website uses.
///
/// Each client also carries the app-relative `"/"` entry, for symmetry with the
/// production clients. It resolves only through the host's
/// [`SelfHostedRedirectResolver`](crate::SelfHostedRedirectResolver), which
/// requires a self-hosted row, so against the cloud dev rows it matches nothing.
/// The redirect path is the origin root for every app but `ohif-viewer-dev`,
/// whose launch lands on `/fhir-viewer` — redirect matching is exact-URL.
///
/// Scopes mirror each app's production client exactly — a dev build of the app
/// requests the same set (`apps/*/src/config.ts`).
///
/// Runtime rather than a migration for the same reason as the app rows:
/// migrations run unconditionally, so a migration-seeded dev client would exist
/// in release databases too. The whole function is `#[cfg(debug_assertions)]`, as
/// is its single call site in the Tauri host.
///
/// Upserted (not insert-if-missing) so a definition change lands on the next boot
/// — the same treatment [`ensure_first_party_client`] gets, and safe here because
/// nothing but this code owns these rows.
///
/// # Errors
///
/// Returns an error if the store cannot be opened/migrated or an upsert fails.
#[cfg(debug_assertions)]
pub fn seed_dev_app_clients(pool: DieselPool) -> anyhow::Result<()> {
    use crate::domain::client::RegisteredRedirectUri;

    let store = SqliteGatekeeperStore::new(pool).context("failed to open gatekeeper store")?;
    // Ports come from the shared dev-port file, not literals — see
    // [`DEV_APP_PORTS_JSON`].
    let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON)
        .expect("the embedded dev-app-ports.json must declare a port per dev app id");
    let dev_clients = [
        (
            "medications-app-dev",
            "Medications (Dev)",
            [
                "launch",
                "launch/patient",
                "openid",
                "fhirUser",
                "system/MedicationRequest.rs",
                "system/Medication.rs",
            ]
            .as_slice(),
            ports.medications_app_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "web-trace-app-dev",
            "Web Trace (Dev)",
            [
                "launch",
                "openid",
                "fhirUser",
                "system/DocumentReference.rs",
            ]
            .as_slice(),
            ports.web_trace_app_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "importer-app-dev",
            "Importer (Dev)",
            // Mirrors the production `importer-app` client's write-carrying set
            // (`apps/importer-web/src/config.ts`, as widened by gatekeeper
            // migration `0009_widen_importer_client_write_scopes`, re-applied by
            // `0015` on an install that skipped it) — a dev build
            // requests the same scopes, and unlike the two viewers above the
            // Importer writes. Full `.cruds` (create + read + update + delete +
            // search) on each handled type.
            [
                "launch",
                "openid",
                "fhirUser",
                "system/DocumentReference.cruds",
                "system/Patient.cruds",
                "system/Observation.cruds",
                "system/Practitioner.cruds",
                "system/DiagnosticReport.cruds",
                "system/Medication.cruds",
                "system/MedicationRequest.cruds",
                "system/MedicationDispense.cruds",
                "system/ServiceRequest.cruds",
                "system/ImagingStudy.cruds",
            ]
            .as_slice(),
            ports.importer_app_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "ohif-viewer-dev",
            "Imaging (Dev)",
            // Mirrors the production `ohif-viewer` client's read-only set (the
            // `smartScope` in `apps/ohif-viewer/config/app-config.js`, seeded
            // by migration `0009`): the launch Patient plus the ImagingStudy and
            // DocumentReference searches the OHIF FHIR data source issues.
            [
                "launch",
                "openid",
                "fhirUser",
                "system/Patient.rs",
                "system/ImagingStudy.rs",
                "system/DocumentReference.rs",
            ]
            .as_slice(),
            ports.ohif_viewer_dev,
            // NOT the root: the OHIF dev app row is a CLOUD row (see
            // `apps_rust::dev_seed`), so its app-relative `"/"` entry no longer
            // resolves and the absolute entry is the only one that can match. It
            // must therefore be the exact route the launch targets — the FHIR
            // Viewer mode, as on the production client (seeded by migration
            // `0009_seed_ohif_viewer_client` and repointed by `0010`), which is
            // where OHIF's data source sends the browser back to and what it
            // passes as `redirect_uri`.
            "/fhir-viewer",
        ),
        (
            "fhir-sync-pebble-dev",
            "FHIR Sync for Pebble (Dev)",
            // Mirrors the production `fhir-sync-pebble` client (migration
            // `0017_seed_fhir_sync_pebble_client`, widened by `0018`, the `scope` in
            // `apps/fhir-sync-pebble-web/src/config.ts`). Standalone-only, so
            // there is no `apps_rust::dev_seed` row: the app-relative entry
            // resolves to nothing and the absolute loopback root carries the
            // `ConnectMenu`'s redirect.
            [
                "openid",
                "fhirUser",
                "system/Patient.rs",
                "system/Observation.cu",
            ]
            .as_slice(),
            ports.fhir_sync_pebble_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "health-viewer-app-dev",
            "Health Viewer (Dev)",
            // `apps/health-viewer/src/config.ts`'s scope string — see
            // [`HEALTH_VIEWER_DEV_SCOPES`].
            HEALTH_VIEWER_DEV_SCOPES,
            ports.health_viewer_app_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "lifting-app-dev",
            "Lifting (Dev)",
            // Mirrors the production `lifting-app` client's write-carrying set
            // (`apps/lifting-app/src/config.ts`'s `standaloneSmartConfig`, seeded
            // by migration `0019_seed_lifting_app_client`), `launch/patient`
            // included for the standalone connect flow as on
            // `medications-app-dev`.
            [
                "launch",
                "launch/patient",
                "openid",
                "fhirUser",
                "system/Patient.rs",
                "system/CarePlan.cruds",
                "system/Goal.cruds",
                "system/Observation.cruds",
            ]
            .as_slice(),
            ports.lifting_app_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
    ];
    for (client_id, name, scopes, port, redirect_path) in dev_clients {
        use url::Url;

        let client = Client {
            client_id: client_id.to_string(),
            name: name.to_string(),
            kind: ClientKind::Public,
            // App-relative: resolves only through the self-hosted resolver, so
            // against these cloud dev rows it matches nothing and the absolute
            // entry below carries the launch. The absolute entry's port comes from the
            // shared `dev-app-ports.json` (above), the same file the apps dev
            // seed and each `vite.config.ts` read — so it is never a literal
            // duplicated here, and its path is the route that client's launch
            // actually lands on (redirect matching is exact-URL).
            redirect_uris: vec![
                RegisteredRedirectUri::AppRelative("/".to_string()),
                RegisteredRedirectUri::Absolute(
                    Url::parse(&format!("http://localhost:{port}{redirect_path}")).unwrap(),
                ),
            ],
            allowed_scopes: scopes.iter().map(|s| (*s).to_string()).collect(),
            allowed_grant_types: vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        };
        store
            .upsert_client(&client)
            .with_context(|| format!("seed dev client {client_id}"))?;
    }
    Ok(())
}

/// Mint an Owner-scoped access token for `wildflower-host`, the
/// first-party client. Called once during [`crate::setup_gatekeeper`] so
/// the host can hand the resulting token to the `WebView` via the
/// navigation bridge and let the Owner UI call `/access/*` endpoints.
///
/// `iss` and `aud` are both [`shared_structures_rust::CANONICAL_ISSUER`], the one
/// audience `require_auth` accepts over both loopback and the tunnel origin
/// (#256). The token carries the `wf_owner` marker (`is_host_owner: true`) so
/// `require_auth` honours that audience only for it. See `docs/Origins/Explanation.md`.
///
/// # Errors
///
/// The minter's [`TokenIssuanceError`]: no active signing key, a signing
/// failure, or a store failure. The boot path adds where it was minting.
pub(crate) fn mint_host_owner_token(
    store: &SqliteGatekeeperStore,
    iss: &str,
    aud: &str,
    ttl: Duration,
    host_owner_scopes: &[String],
    first_party_client_id: &str,
) -> Result<String, TokenIssuanceError> {
    // The host owner token carries the host's granted scopes (by default the FHIR
    // and Wildflower full-access wildcards): it gates HFS's FHIR surface, and —
    // because those wildcards cover every per-resource scope the `Scoped<…>`
    // extractors require — it passes every gate on gatekeeper's `/access/*` admin
    // surface too. `setup_gatekeeper` asserts the granted set covers
    // `WILDFLOWER_WIDEST_SCOPES` before we reach here.
    //
    // The one token minted with no approving human: its authority is the named
    // `HostOwnerEntitlement` proof (constructible only here), through the same
    // minter.
    let entitlement = HostOwnerEntitlement::for_host(first_party_client_id, host_owner_scopes);
    AccessTokenMinter::new(store, iss, aud, ttl).mint(TokenEntitlement::HostOwner(&entitlement))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The health viewer's dev client is seeded on its dev server's loopback
    /// root with exactly the scopes the app requests. The app's scope string
    /// is read out of `config.ts` itself, the one place it is written, so the
    /// TS and Rust halves cannot drift apart unnoticed.
    #[test]
    fn seeds_the_health_viewer_dev_client_with_the_apps_own_scopes() {
        use crate::domain::client::RegisteredRedirectUri;

        const HEALTH_VIEWER_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../apps/health-viewer/src/config.ts"
        ));
        let scope_string = format!("'{}'", HEALTH_VIEWER_DEV_SCOPES.join(" "));
        assert!(
            HEALTH_VIEWER_CONFIG_TS.contains(&scope_string),
            "apps/health-viewer/src/config.ts must request exactly {scope_string}",
        );

        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGatekeeperStore::new(pool).expect("open gatekeeper store");
        let client = store
            .client_by_id("health-viewer-app-dev")
            .expect("query client")
            .expect("health viewer dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, HEALTH_VIEWER_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                RegisteredRedirectUri::AppRelative("/".to_owned()),
                RegisteredRedirectUri::Absolute(
                    format!("http://localhost:{}/", ports.health_viewer_app_dev)
                        .parse()
                        .expect("a valid absolute redirect"),
                ),
            ],
        );
    }

    /// The first-party client is seeded under the `client_id` threaded through
    /// `open_and_seed_store` (from `GatekeeperConfig::first_party_client_id`,
    /// which the live app sources from `tauri-shared-config.json`), NOT a
    /// hardcoded literal. This is the cross-boundary drift guard: the TS shell's
    /// device-login `client_id` and the seeded id derive from one source, so a
    /// regression that re-hardcodes the id here (letting it drift from the config
    /// / the TS side) fails this test.
    #[test]
    fn seeds_first_party_client_under_the_configured_id() {
        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        let scopes = vec![
            "system/*.cruds".to_string(),
            "wildflower/*.cruds".to_string(),
        ];
        let store = open_and_seed_store(pool, &scopes, "custom-host-client").expect("seed store");

        let seeded = store
            .client_by_id("custom-host-client")
            .expect("query client")
            .expect("first-party client seeded under the configured id");
        assert_eq!(seeded.client_id, "custom-host-client");
        assert_eq!(seeded.allowed_scopes, scopes);

        // Nothing is seeded under the fallback const's literal — proving the id
        // came from the argument, not `FIRST_PARTY_CLIENT_ID`.
        assert!(
            store
                .client_by_id(crate::FIRST_PARTY_CLIENT_ID)
                .expect("query fallback id")
                .is_none(),
            "seeding must use the configured id, not the hardcoded fallback",
        );
    }
}
