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
    "/../../../../dev-app-ports.json"
));

/// The subset of [`DEV_APP_PORTS_JSON`] this seed needs — the seven first-party
/// apps that register an OAuth client. The file also carries `server-docs-dev`
/// and `watch-lifts-dev`, which are not SMART apps and so have no client
/// here; serde ignores them.
#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
struct DevAppPorts {
    #[serde(rename = "medications-dev")]
    medications_dev: u16,
    #[serde(rename = "importer-dev")]
    importer_dev: u16,
    #[serde(rename = "ohif-viewer-dev")]
    ohif_viewer_dev: u16,
    #[serde(rename = "fhir-sync-pebble-dev")]
    fhir_sync_pebble_dev: u16,
    #[serde(rename = "health-viewer-dev")]
    health_viewer_dev: u16,
    #[serde(rename = "synthetic-data-dev")]
    synthetic_data_dev: u16,
    #[serde(rename = "lifting-dev")]
    lifting_dev: u16,
}

/// The dev tiles' OAuth clients: random ids (`openssl rand -hex 16`), not the
/// tile ids (`medications-dev` and so on). `apps_rust::dev_seed` points each tile
/// at its client, and each app's `src/config.ts` launches as it under the dev
/// server.
#[cfg(debug_assertions)]
const MEDICATIONS_DEV_CLIENT_ID: &str = "4be2ee91360733fdcb99b43a3822de5f";
#[cfg(debug_assertions)]
const IMPORTER_DEV_CLIENT_ID: &str = "57268ff88aea38d6a22de56ae53e2c28";
#[cfg(debug_assertions)]
const HEALTH_VIEWER_DEV_CLIENT_ID: &str = "e7efc7c805f5f8f640bb3b3d48a2d7aa";
#[cfg(debug_assertions)]
const SYNTHETIC_DATA_DEV_CLIENT_ID: &str = "07a31e58db3367afda5c6480e03ed993";
#[cfg(debug_assertions)]
const LIFTING_DEV_CLIENT_ID: &str = "8467e680a05f1e92e22864e923144e5a";

/// The Health Viewer dev client's scopes: exactly the scope string in
/// `apps/health-viewer/health-viewer-web/src/config.ts`, which requests the same set for an EHR
/// launch and a standalone connect, and the same set the production
/// Health Viewer client allows (gatekeeper migration
/// `0022_seed_health_viewer_app_client`, re-keyed by `0028_rekey_site_app_clients`). A test below reads that file and pins
/// all three together, so a scope added on one side alone fails the test rather
/// than `/authorize` on a real device.
#[cfg(debug_assertions)]
const HEALTH_VIEWER_DEV_SCOPES: &[&str] = &[
    "launch",
    "openid",
    "fhirUser",
    "system/Observation.rs",
    "system/MedicationRequest.rs",
    "system/Patient.rs",
];

/// The Synthetic Data Loader dev client's scopes: exactly the scope string in
/// `apps/synthetic-data/synthetic-data-web/src/config.ts`, which requests the same set for an
/// EHR launch and a standalone connect, and the same set the production client
/// allows (gatekeeper migration `0028_rekey_site_app_clients`). A test below
/// reads that file and pins all three together.
#[cfg(debug_assertions)]
const SYNTHETIC_DATA_DEV_SCOPES: &[&str] = &[
    "launch",
    "openid",
    "fhirUser",
    "system/Patient.cu",
    "system/Practitioner.cu",
    "system/DocumentReference.cu",
    "system/Observation.cu",
    "system/DiagnosticReport.cu",
    "system/Medication.cu",
    "system/MedicationRequest.cu",
    "system/MedicationDispense.cu",
    "system/ServiceRequest.cu",
    "system/ImagingStudy.cu",
];

/// The Medications dev client's scopes: exactly `MEDICATIONS_SCOPE` in
/// `apps/medications/medications-web/src/config.ts`, which requests the same set for an
/// EHR launch and a standalone connect, and the same set the production
/// Medications client allows (gatekeeper migration
/// `0020_first_party_apps_pick_the_patient`, re-keyed by `0028_rekey_site_app_clients`). A test below reads that file and
/// pins all three together.
#[cfg(debug_assertions)]
const MEDICATIONS_DEV_SCOPES: &[&str] = &[
    "launch",
    "openid",
    "fhirUser",
    "system/MedicationRequest.rs",
    "system/Medication.rs",
    "system/Patient.rs",
];

/// The Lifting dev client's scopes: exactly `LIFTING_SCOPE` in
/// `apps/lifting/lifting-web/src/config.ts`, which requests the same set for an
/// EHR launch and a standalone connect, and the same set the production Lifting
/// client allows (gatekeeper migrations `0019_seed_lifting_app_client` and
/// `0020_first_party_apps_pick_the_patient`, re-keyed by
/// `0025_rekey_lifting_app_clients`).
/// A test below reads that file and pins all three together. Writes are
/// `.crus`: every write is an update-as-create to a client-minted id, and the
/// app never deletes.
#[cfg(debug_assertions)]
const LIFTING_DEV_SCOPES: &[&str] = &[
    "launch",
    "openid",
    "fhirUser",
    "system/Patient.rs",
    "system/PlanDefinition.crus",
    "system/ServiceRequest.crus",
    "system/Procedure.crus",
    "system/Observation.crus",
];

/// The loopback redirect route for a dev app served at its origin root — every
/// first-party app but the OHIF viewer, whose launch targets a sub-route.
#[cfg(debug_assertions)]
const DEV_ROOT_REDIRECT_PATH: &str = "/";

/// The debug-only OAuth clients for the first-party apps' vite dev servers — the
/// gatekeeper half of `apps_rust::seed_dev_apps`.
///
/// The first-party SMART apps (Medications, Importer, the OHIF
/// imaging viewer, Lifting) ship as rows served from
/// <https://wildflowerhealth.io> (apps migrations `0005_first_party_apps_to_cloud`
/// onward), whose clients register the published-site redirect URI. A debug
/// build also gets an `<app>-dev` row (`apps_rust::dev_seed`) whose launch
/// URL points at the app's local vite dev server on the port
/// `dev-app-ports.json` pins, and that row needs its own client — named after
/// the dev app id for the OHIF viewer and FHIR Sync, a random id for the rest —
/// whose absolute
/// `http://localhost:{port}` redirect is what the authorize flow matches. They are separate clients rather than extra
/// redirect entries on the production ones because adding a plaintext loopback
/// redirect there would register it on a client that a public website uses.
///
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
    let store = SqliteGatekeeperStore::new(pool).context("failed to open gatekeeper store")?;
    // Ports come from the shared dev-port file, not literals — see
    // [`DEV_APP_PORTS_JSON`].
    let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON)
        .expect("the embedded dev-app-ports.json must declare a port per dev app id");
    let dev_clients = [
        (
            MEDICATIONS_DEV_CLIENT_ID,
            "Medications (Dev)",
            // `apps/medications/medications-web/src/config.ts`'s `MEDICATIONS_SCOPE` — see
            // [`MEDICATIONS_DEV_SCOPES`].
            MEDICATIONS_DEV_SCOPES,
            ports.medications_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            IMPORTER_DEV_CLIENT_ID,
            "Importer (Dev)",
            // Mirrors the production Importer client's write-carrying set
            // (`apps/importer-web/src/config.ts`, as widened by gatekeeper
            // migration `0009_widen_importer_client_write_scopes`, re-applied by
            // `0015` on an install that skipped it) — a dev build
            // requests the same scopes, and unlike the medications viewer above the
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
            ports.importer_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            "ohif-viewer-dev",
            "Imaging (Dev)",
            // Mirrors the production `ohif-viewer` client's read-only set (the
            // `smartScope` in `apps/ohif-viewer-web/config/app-config.js`, seeded
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
            // NOT the root: redirect matching is exact-URL, so the entry must be
            // the exact route the launch targets — the FHIR
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
            // `apps/fhir-sync-pebble/fhir-sync-pebble-web/src/config.ts`). Standalone-only, so
            // there is no `apps_rust::dev_seed` row; the loopback root carries
            // the `ConnectMenu`'s redirect.
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
            HEALTH_VIEWER_DEV_CLIENT_ID,
            "Health Viewer (Dev)",
            // `apps/health-viewer/health-viewer-web/src/config.ts`'s scope string — see
            // [`HEALTH_VIEWER_DEV_SCOPES`].
            HEALTH_VIEWER_DEV_SCOPES,
            ports.health_viewer_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            SYNTHETIC_DATA_DEV_CLIENT_ID,
            "Synthetic Data (Dev)",
            // `apps/synthetic-data/synthetic-data-web/src/config.ts`'s scope string — see
            // [`SYNTHETIC_DATA_DEV_SCOPES`].
            SYNTHETIC_DATA_DEV_SCOPES,
            ports.synthetic_data_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
        (
            LIFTING_DEV_CLIENT_ID,
            "Lifting (Dev)",
            // `apps/lifting/lifting-web/src/config.ts`'s `LIFTING_SCOPE` — see
            // [`LIFTING_DEV_SCOPES`].
            LIFTING_DEV_SCOPES,
            ports.lifting_dev,
            DEV_ROOT_REDIRECT_PATH,
        ),
    ];
    for (client_id, name, scopes, port, redirect_path) in dev_clients {
        use url::Url;

        let client = Client {
            client_id: client_id.to_string(),
            name: name.to_string(),
            kind: ClientKind::Public,
            // The port comes from the shared `dev-app-ports.json` (above), the
            // same file the apps dev seed and each `vite.config.ts` read — so it
            // is never a literal duplicated here, and the path is the route that
            // client's launch actually lands on (redirect matching is exact-URL).
            redirect_uris: vec![
                Url::parse(&format!("http://localhost:{port}{redirect_path}")).unwrap(),
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
/// navigation bridge and let the launcher call `/access/*` endpoints.
///
/// `iss` and `aud` are both `server_origin`, like every token this server
/// mints, so it is accepted over loopback and through the tunnel alike. See
/// `docs/Origins/Explanation.md`.
///
/// # Errors
///
/// The minter's [`TokenIssuanceError`]: no active signing key, a signing
/// failure, or a store failure. The boot path adds where it was minting.
pub(crate) fn mint_host_owner_token(
    store: &SqliteGatekeeperStore,
    server_origin: &str,
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
    AccessTokenMinter::new(store, server_origin, ttl)
        .mint(TokenEntitlement::HostOwner(&entitlement))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The health viewer's dev client is seeded on its dev server's loopback
    /// root with exactly the scopes the app requests, and the production client
    /// (gatekeeper migration `0022`, re-keyed by `0028`) allows the same set.
    /// The app's scope string and both client ids are read out of `config.ts`
    /// itself, the one place the app writes them, so neither client can drift
    /// from it unnoticed.
    #[test]
    fn seeds_the_health_viewer_dev_client_with_the_apps_own_scopes() {
        const HEALTH_VIEWER_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/health-viewer/health-viewer-web/src/config.ts"
        ));
        /// The production client `0028_rekey_site_app_clients` re-keys to.
        const HEALTH_VIEWER_CLIENT_ID: &str = "474e103de61f9141c4b640d59bfa130e";
        let scope_string = format!("'{}'", HEALTH_VIEWER_DEV_SCOPES.join(" "));
        assert!(
            HEALTH_VIEWER_CONFIG_TS.contains(&scope_string),
            "apps/health-viewer/health-viewer-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [HEALTH_VIEWER_DEV_CLIENT_ID, HEALTH_VIEWER_CLIENT_ID] {
            assert!(
                HEALTH_VIEWER_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/health-viewer/health-viewer-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGatekeeperStore::new(pool).expect("open gatekeeper store");
        let client = store
            .client_by_id(HEALTH_VIEWER_DEV_CLIENT_ID)
            .expect("query client")
            .expect("health viewer dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, HEALTH_VIEWER_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.health_viewer_dev))
                    .expect("a valid absolute redirect")
            ],
        );

        let production = store
            .client_by_id(HEALTH_VIEWER_CLIENT_ID)
            .expect("query client")
            .expect("migration 0028 re-keys the Health Viewer client");
        assert_eq!(production.allowed_scopes, HEALTH_VIEWER_DEV_SCOPES);
    }

    /// The synthetic data loader's dev client is seeded on its dev server's
    /// loopback root with exactly the scopes the app requests, and the
    /// production client (gatekeeper migration `0028`) allows the same set, read
    /// out of `config.ts` itself with both client ids, as the health viewer's are.
    #[test]
    fn seeds_the_synthetic_data_dev_client_with_the_apps_own_scopes() {
        const SYNTHETIC_DATA_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/synthetic-data/synthetic-data-web/src/config.ts"
        ));
        /// The production client `0028_rekey_site_app_clients` seeds.
        const SYNTHETIC_DATA_CLIENT_ID: &str = "225ba6af034a3acec6be7ff8010df67f";
        let scope_string = format!("'{}'", SYNTHETIC_DATA_DEV_SCOPES.join(" "));
        assert!(
            SYNTHETIC_DATA_CONFIG_TS.contains(&scope_string),
            "apps/synthetic-data/synthetic-data-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [SYNTHETIC_DATA_DEV_CLIENT_ID, SYNTHETIC_DATA_CLIENT_ID] {
            assert!(
                SYNTHETIC_DATA_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/synthetic-data/synthetic-data-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGatekeeperStore::new(pool).expect("open gatekeeper store");
        let client = store
            .client_by_id(SYNTHETIC_DATA_DEV_CLIENT_ID)
            .expect("query client")
            .expect("synthetic data dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, SYNTHETIC_DATA_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.synthetic_data_dev))
                    .expect("a valid absolute redirect")
            ],
        );
    }

    /// The Medications dev client is seeded on its dev server's loopback root
    /// with exactly the scopes the app requests, and the production client
    /// (gatekeeper migrations `0004` / `0011`, then `0020`, re-keyed by `0028`)
    /// allows the same set. The app's `MEDICATIONS_SCOPE` and both client ids are
    /// read out of `config.ts` itself, the one place the app writes them, so
    /// neither client can drift from it unnoticed.
    #[test]
    fn seeds_the_medications_dev_client_with_the_apps_own_scopes() {
        const MEDICATIONS_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/medications/medications-web/src/config.ts"
        ));
        /// The production client `0028_rekey_site_app_clients` re-keys to.
        const MEDICATIONS_CLIENT_ID: &str = "9769f8b274370708d0d3ebb2e3e59b7c";
        let scope_string = format!("'{}'", MEDICATIONS_DEV_SCOPES.join(" "));
        assert!(
            MEDICATIONS_CONFIG_TS.contains(&scope_string),
            "apps/medications/medications-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [MEDICATIONS_DEV_CLIENT_ID, MEDICATIONS_CLIENT_ID] {
            assert!(
                MEDICATIONS_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/medications/medications-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGatekeeperStore::new(pool).expect("open gatekeeper store");
        let client = store
            .client_by_id(MEDICATIONS_DEV_CLIENT_ID)
            .expect("query client")
            .expect("medications dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, MEDICATIONS_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.medications_dev))
                    .expect("a valid absolute redirect")
            ],
        );

        let production = store
            .client_by_id(MEDICATIONS_CLIENT_ID)
            .expect("query client")
            .expect("migration 0028 re-keys the Medications client");
        assert_eq!(production.allowed_scopes, MEDICATIONS_DEV_SCOPES);
    }

    /// The Lifting dev client is seeded on its dev server's loopback root with
    /// exactly the scopes the app requests, and the production Lifting client
    /// (gatekeeper migrations `0019`, `0020` and `0025`) allows the same set. The
    /// app's `LIFTING_SCOPE` and both client ids are read out of `config.ts`
    /// itself, the one place the app writes them, so neither client can drift
    /// from it unnoticed.
    #[test]
    fn seeds_the_lifting_dev_client_with_the_apps_own_scopes() {
        const LIFTING_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/lifting/lifting-web/src/config.ts"
        ));
        /// The production client `0025_rekey_lifting_app_clients` re-keys to.
        const LIFTING_CLIENT_ID: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";
        let scope_string = format!("'{}'", LIFTING_DEV_SCOPES.join(" "));
        assert!(
            LIFTING_CONFIG_TS.contains(&scope_string),
            "apps/lifting/lifting-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [LIFTING_DEV_CLIENT_ID, LIFTING_CLIENT_ID] {
            assert!(
                LIFTING_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/lifting/lifting-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGatekeeperStore::new(pool).expect("open gatekeeper store");
        let client = store
            .client_by_id(LIFTING_DEV_CLIENT_ID)
            .expect("query client")
            .expect("lifting dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, LIFTING_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.lifting_dev))
                    .expect("a valid absolute redirect")
            ],
        );

        let production = store
            .client_by_id(LIFTING_CLIENT_ID)
            .expect("query client")
            .expect("migration 0025 re-keys the Lifting client");
        assert_eq!(production.allowed_scopes, LIFTING_DEV_SCOPES);
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
