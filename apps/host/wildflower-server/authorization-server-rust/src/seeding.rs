//! First-boot seeding for the grant store: the signing key and the essential
//! clients (the host app's client and the browser-session client). Safe to call
//! on every boot — the signing key is inserted only when none exists (never
//! rotated), and the two clients are *ensured* (re-applied as an upsert) so
//! their definitions always match the host's granted scopes, correcting any
//! drift in the stored rows.
//!
//! The bundled SMART sample-app clients (growth-chart, medication-viewer →
//! `my_web_app`, PRECISE-HBR) are seeded in SQL instead — migration
//! `0003_seed_sample_clients` — since they're static definitions a migration
//! can express. Only the runtime-derived seeds (the essential clients' scopes,
//! the generated signing key) stay here.

use anyhow::Context;
use chrono::Utc;
use wildflowerhealthio_persistence::DieselPool;

use wildflowerhealthio_scopes::{Permission, Scope};

use crate::db::SqliteGrantStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegistrationSource};
use crate::domain::grant_store::{ClientsTx, SigningKeysTx};
use crate::domain::signing_key::SigningKey;
use crate::domain::GrantStore as _;

/// Wrap the host-owned connection `pool` in a grant store (applying
/// migrations, which includes the SQL seed of the SMART sample-app clients)
/// and run the runtime-derived first-boot seeding steps — the signing key, the
/// essential clients, and the FHIR server UI's client. Safe to call on every
/// boot.
///
/// # Errors
///
/// Returns an error if the store cannot be created (migrations) or if any seeding
/// step fails.
pub fn open_and_seed_store(
    pool: DieselPool,
    host_app_client_scopes: &[String],
    fhir_ui_client_id: &str,
    server_origin: &url::Url,
) -> anyhow::Result<SqliteGrantStore> {
    let store = SqliteGrantStore::new(pool).context("failed to open grant store")?;
    // RSA key generation is slow, so it runs before the write lock is taken,
    // and only on a boot that finds no active key.
    let candidate_signing_key = if store
        .read(|tx| tx.active_signing_key())
        .context("failed to read signing keys")?
        .is_none()
    {
        Some(SigningKey::generate().context("failed to generate signing key")?)
    } else {
        None
    };
    store.write(|tx| -> anyhow::Result<()> {
        ensure_some_active_signing_key(tx, candidate_signing_key)
            .context("failed to seed signing key")?;
        ensure_essential_clients(tx, host_app_client_scopes)
            .context("failed to seed the essential clients")?;
        ensure_fhir_ui_client(tx, fhir_ui_client_id, server_origin)
            .context("failed to seed the FHIR server UI client")
    })?;
    Ok(store)
}

/// The FHIR server UI's client: a public client (PKCE, no secret) whose one
/// redirect URI is `{server_origin}/ui/callback`, where `helios-ui` completes
/// its sign-in, allowed `user/*.cruds` — the UI acts as the signed-in user
/// across every resource type. Upserted on every boot, like
/// [`ensure_essential_clients`], so it follows the server's origin.
fn ensure_fhir_ui_client(
    tx: &mut impl ClientsTx,
    fhir_ui_client_id: &str,
    server_origin: &url::Url,
) -> anyhow::Result<()> {
    let client = Client {
        client_id: fhir_ui_client_id.to_string(),
        name: "FHIR server UI".to_string(),
        kind: ClientKind::Public,
        redirect_uris: vec![server_origin
            .join("/ui/callback")
            .context("build the UI's redirect URI")?],
        allowed_scopes: vec![Scope::fhir_user_all(Permission::ALL).to_string()],
        allowed_grant_types: vec![
            AllowedGrantType::AuthorizationCode,
            AllowedGrantType::RefreshToken,
        ],
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
        registration_source: RegistrationSource::ServerDefined,
    };
    tx.upsert_client(&client)
        .context("seed the FHIR server UI client")?;
    Ok(())
}

/// Insert `candidate`, generated before the scope opened, as the active
/// signing key if none is active; otherwise leave the existing keys alone.
/// Idempotent — safe to call on every boot.
fn ensure_some_active_signing_key(
    tx: &mut impl SigningKeysTx,
    candidate: Option<SigningKey>,
) -> anyhow::Result<()> {
    let existing = tx.active_signing_key().context("read signing keys")?;
    if existing.is_some() {
        return Ok(());
    }
    let mut key = candidate.context("the active signing key vanished during seeding")?;
    key.is_active = true;
    tx.insert_signing_key(&key).context("insert signing key")?;
    Ok(())
}

/// Ensure the essential clients — the host app's client
/// ([`crate::WILDFLOWER_HOST_APP_CLIENT_ID`]) and the browser-session client
/// ([`crate::BROWSER_SESSION_CLIENT_ID`]) — match the code's definitions.
/// Upserted on every boot so their policy always matches: the host app's
/// client is allowed `host_app_client_scopes` (the live app sources them from
/// `tauri-shared-config.json`; see [`crate::default_host_app_client_scopes`]),
/// and the browser-session
/// client the Owner's scopes ([`crate::OWNER_SCOPES`]), the most any browser
/// session may hold. This corrects stored rows that have drifted
/// (registration time and any admin disable are preserved).
///
/// Both are public with no redirect URIs. The host app's client is allowed
/// every grant type; the browser-session client none, since its tokens are
/// minted only at `/oauth/sign-in` (a same-device session) and by the pairing
/// page's poll (a paired session), neither of them OAuth, so no OAuth flow
/// can be run as it and `/oauth/token` never mints its token.
fn ensure_essential_clients(
    tx: &mut impl ClientsTx,
    host_app_client_scopes: &[String],
) -> anyhow::Result<()> {
    let wildflower_host_app_client = Client {
        client_id: crate::WILDFLOWER_HOST_APP_CLIENT_ID.to_string(),
        name: "Wildflower Host".to_string(),
        kind: ClientKind::Public,
        redirect_uris: vec![],
        allowed_scopes: host_app_client_scopes.to_vec(),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
        registration_source: RegistrationSource::ServerDefined,
    };
    tx.upsert_client(&wildflower_host_app_client)
        .context("seed the host app's client")?;
    let browser_session_client = Client {
        client_id: crate::BROWSER_SESSION_CLIENT_ID.to_string(),
        name: "Wildflower Browsers".to_string(),
        kind: ClientKind::Public,
        redirect_uris: vec![],
        allowed_scopes: crate::owner_scopes(),
        allowed_grant_types: vec![],
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
        registration_source: RegistrationSource::ServerDefined,
    };
    tx.upsert_client(&browser_session_client)
        .context("seed the browser-session client")?;
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
    /// The port the Medications vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "medications-dev")]
    medications_dev: u16,
    /// The port the Importer vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "importer-dev")]
    importer_dev: u16,
    /// The port the OHIF imaging viewer vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "ohif-viewer-dev")]
    ohif_viewer_dev: u16,
    /// The port the FHIR Sync for Pebble vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "fhir-sync-pebble-dev")]
    fhir_sync_pebble_dev: u16,
    /// The port the Plots vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "plots-dev")]
    plots_dev: u16,
    /// The port the Synthetic Data Loader vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "synthetic-data-dev")]
    synthetic_data_dev: u16,
    /// The port the Strength vite dev server listens on, and its dev client's
    /// loopback redirect names.
    #[serde(rename = "strength-dev")]
    strength_dev: u16,
}

/// The Medications dev server's client.
///
/// The dev tiles' OAuth clients have random ids (`openssl rand -hex 16`), not
/// the tile ids (`medications-dev` and so on). `wildflowerhealthio_apps::dev_seed`
/// points each tile at its client, and each app's `src/config.ts` (the OHIF
/// viewer's `config/app-config.js` and launch URL) launches as it under the dev
/// server. FHIR Sync for Pebble has no tile; its `src/config.ts` alone names its
/// client.
#[cfg(debug_assertions)]
const MEDICATIONS_DEV_CLIENT_ID: &str = "4be2ee91360733fdcb99b43a3822de5f";
/// The Importer dev server's client.
#[cfg(debug_assertions)]
const IMPORTER_DEV_CLIENT_ID: &str = "57268ff88aea38d6a22de56ae53e2c28";
/// The Plots dev server's client.
#[cfg(debug_assertions)]
const PLOTS_DEV_CLIENT_ID: &str = "e7efc7c805f5f8f640bb3b3d48a2d7aa";
/// The Synthetic Data Loader dev server's client.
#[cfg(debug_assertions)]
const SYNTHETIC_DATA_DEV_CLIENT_ID: &str = "07a31e58db3367afda5c6480e03ed993";
/// The Strength dev server's client.
#[cfg(debug_assertions)]
const STRENGTH_DEV_CLIENT_ID: &str = "8467e680a05f1e92e22864e923144e5a";
/// The OHIF imaging viewer dev server's client.
#[cfg(debug_assertions)]
const OHIF_VIEWER_DEV_CLIENT_ID: &str = "f9866f7b1d0d8505dc65ef4f749664b5";
/// The FHIR Sync for Pebble dev server's client. It has no dev tile: the app
/// is standalone-only.
#[cfg(debug_assertions)]
const FHIR_SYNC_PEBBLE_DEV_CLIENT_ID: &str = "61e195d6b08bab6bf2cedb1ef3831fa7";

/// The Plots dev client's scopes: exactly the scope string in
/// `apps/plots/plots-web/src/config.ts`, which requests the same set for an EHR
/// launch and a standalone connect, and the same set the production
/// Plots client allows (the authorization server migration
/// `0022_seed_health_viewer_app_client`, re-keyed by `0028_rekey_site_app_clients`). A test below reads that file and pins
/// all three together, so a scope added on one side alone fails the test rather
/// than `/authorize` on a real device.
#[cfg(debug_assertions)]
const PLOTS_DEV_SCOPES: &[&str] = &[
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
/// allows (the authorization server migration `0028_rekey_site_app_clients`). A test below
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
/// Medications client allows (the authorization server migration
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

/// The Strength dev client's scopes: exactly `STRENGTH_SCOPE` in
/// `apps/strength/strength-web/src/config.ts`, which requests the same set for an
/// EHR launch and a standalone connect, and the same set the production Strength
/// client allows (authorization server migrations `0019_seed_lifting_app_client` and
/// `0020_first_party_apps_pick_the_patient`, re-keyed by
/// `0025_rekey_lifting_app_clients`).
/// A test below reads that file and pins all three together. Writes are
/// `.crus`: every write is an update-as-create to a client-minted id, and the
/// app never deletes.
#[cfg(debug_assertions)]
const STRENGTH_DEV_SCOPES: &[&str] = &[
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
/// authorization server half of `wildflowerhealthio_apps::seed_dev_apps`.
///
/// The first-party SMART apps (Medications, Importer, the OHIF
/// imaging viewer, Strength) ship as rows served from
/// <https://wildflowerhealth.io> (apps migrations `0005_first_party_apps_to_cloud`
/// onward), whose clients register the published-site redirect URI. A debug
/// build also gets an `<app>-dev` row (`wildflowerhealthio_apps::dev_seed`) whose launch
/// URL points at the app's local vite dev server on the port
/// `dev-app-ports.json` pins, and that row needs its own client, under a
/// random id, whose absolute `http://localhost:{port}` redirect is what the
/// authorize flow matches (FHIR Sync for Pebble has no row, but its dev server
/// gets a client the same way). They are separate clients rather than extra
/// redirect entries on the production ones because adding a plaintext loopback
/// redirect there would register it on a client that a public website uses.
///
/// The redirect path is the origin root for every app but the OHIF viewer,
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
/// — the same treatment `ensure_essential_clients` gets, and safe here because
/// nothing but this code owns these rows.
///
/// # Errors
///
/// Returns an error if the store cannot be opened/migrated or an upsert fails.
#[cfg(debug_assertions)]
pub fn seed_dev_app_clients(pool: DieselPool) -> anyhow::Result<()> {
    let store = SqliteGrantStore::new(pool).context("failed to open grant store")?;
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
            // (`apps/importer-web/src/config.ts`, as widened by the authorization server
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
            OHIF_VIEWER_DEV_CLIENT_ID,
            "Imaging (Dev)",
            // Mirrors the production OHIF viewer client's read-only set (the
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
            FHIR_SYNC_PEBBLE_DEV_CLIENT_ID,
            "FHIR Sync for Pebble (Dev)",
            // Mirrors the production FHIR Sync for Pebble client (migration
            // `0017_seed_fhir_sync_pebble_client`, widened by `0018`, re-keyed by
            // `0030`, the `scope` in
            // `apps/fhir-sync-pebble/fhir-sync-pebble-web/src/config.ts`). Standalone-only, so
            // there is no `wildflowerhealthio_apps::dev_seed` row; the loopback root carries
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
            PLOTS_DEV_CLIENT_ID,
            "Plots (Dev)",
            // `apps/plots/plots-web/src/config.ts`'s scope string — see
            // [`PLOTS_DEV_SCOPES`].
            PLOTS_DEV_SCOPES,
            ports.plots_dev,
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
            STRENGTH_DEV_CLIENT_ID,
            "Wildflower Strength (Dev)",
            // `apps/strength/strength-web/src/config.ts`'s `STRENGTH_SCOPE` — see
            // [`STRENGTH_DEV_SCOPES`].
            STRENGTH_DEV_SCOPES,
            ports.strength_dev,
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
            registration_source: RegistrationSource::TrustedOnFirstUse,
        };
        store
            .write(|tx| tx.upsert_client(&client))
            .with_context(|| format!("seed dev client {client_id}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Plots dev client is seeded on its dev server's loopback
    /// root with exactly the scopes the app requests, and the production client
    /// (the authorization server migration `0022`, re-keyed by `0028`) allows the same set.
    /// The app's scope string and both client ids are read out of `config.ts`
    /// itself, the one place the app writes them, so neither client can drift
    /// from it unnoticed.
    #[test]
    fn seeds_the_plots_dev_client_with_the_apps_own_scopes() {
        const PLOTS_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/plots/plots-web/src/config.ts"
        ));
        /// The production client `0028_rekey_site_app_clients` re-keys to.
        const PLOTS_CLIENT_ID: &str = "474e103de61f9141c4b640d59bfa130e";
        let scope_string = format!("'{}'", PLOTS_DEV_SCOPES.join(" "));
        assert!(
            PLOTS_CONFIG_TS.contains(&scope_string),
            "apps/plots/plots-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [PLOTS_DEV_CLIENT_ID, PLOTS_CLIENT_ID] {
            assert!(
                PLOTS_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/plots/plots-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGrantStore::new(pool).expect("open grant store");
        let client = store
            .read(|tx| tx.client_by_id(PLOTS_DEV_CLIENT_ID))
            .expect("query client")
            .expect("plots dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, PLOTS_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.plots_dev))
                    .expect("a valid absolute redirect")
            ],
        );

        let production = store
            .read(|tx| tx.client_by_id(PLOTS_CLIENT_ID))
            .expect("query client")
            .expect("migration 0028 re-keys the Plots client");
        assert_eq!(production.allowed_scopes, PLOTS_DEV_SCOPES);
    }

    /// The synthetic data loader's dev client is seeded on its dev server's
    /// loopback root with exactly the scopes the app requests, and the
    /// production client (the authorization server migration `0028`) allows the same set, read
    /// out of `config.ts` itself with both client ids, as Plots' are.
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

        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGrantStore::new(pool).expect("open grant store");
        let client = store
            .read(|tx| tx.client_by_id(SYNTHETIC_DATA_DEV_CLIENT_ID))
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
    /// (authorization server migrations `0004` / `0011`, then `0020`, re-keyed by `0028`)
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

        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGrantStore::new(pool).expect("open grant store");
        let client = store
            .read(|tx| tx.client_by_id(MEDICATIONS_DEV_CLIENT_ID))
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
            .read(|tx| tx.client_by_id(MEDICATIONS_CLIENT_ID))
            .expect("query client")
            .expect("migration 0028 re-keys the Medications client");
        assert_eq!(production.allowed_scopes, MEDICATIONS_DEV_SCOPES);
    }

    /// The Strength dev client is seeded on its dev server's loopback root with
    /// exactly the scopes the app requests, and the production Strength client
    /// (authorization server migrations `0019`, `0020` and `0025`) allows the same set. The
    /// app's `STRENGTH_SCOPE` and both client ids are read out of `config.ts`
    /// itself, the one place the app writes them, so neither client can drift
    /// from it unnoticed.
    #[test]
    fn seeds_the_strength_dev_client_with_the_apps_own_scopes() {
        const STRENGTH_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/strength/strength-web/src/config.ts"
        ));
        /// The production client `0025_rekey_lifting_app_clients` re-keys to.
        const STRENGTH_CLIENT_ID: &str = "bdf9fc5cb5a28c6683b49896b0ef8a75";
        let scope_string = format!("'{}'", STRENGTH_DEV_SCOPES.join(" "));
        assert!(
            STRENGTH_CONFIG_TS.contains(&scope_string),
            "apps/strength/strength-web/src/config.ts must request exactly {scope_string}",
        );
        for client_id in [STRENGTH_DEV_CLIENT_ID, STRENGTH_CLIENT_ID] {
            assert!(
                STRENGTH_CONFIG_TS.contains(&format!("'{client_id}'")),
                "apps/strength/strength-web/src/config.ts must launch as {client_id}",
            );
        }

        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        seed_dev_app_clients(pool.clone()).expect("seed dev clients");
        let store = SqliteGrantStore::new(pool).expect("open grant store");
        let client = store
            .read(|tx| tx.client_by_id(STRENGTH_DEV_CLIENT_ID))
            .expect("query client")
            .expect("strength dev client seeded");
        let ports: DevAppPorts = serde_json::from_str(DEV_APP_PORTS_JSON).expect("dev ports");
        assert_eq!(client.kind, ClientKind::Public);
        assert_eq!(client.allowed_scopes, STRENGTH_DEV_SCOPES);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse(&format!("http://localhost:{}/", ports.strength_dev))
                    .expect("a valid absolute redirect")
            ],
        );

        let production = store
            .read(|tx| tx.client_by_id(STRENGTH_CLIENT_ID))
            .expect("query client")
            .expect("migration 0025 re-keys the Strength client");
        assert_eq!(production.allowed_scopes, STRENGTH_DEV_SCOPES);
    }

    /// The host app's client is seeded under
    /// [`crate::WILDFLOWER_HOST_APP_CLIENT_ID`] with the scopes threaded
    /// through `open_and_seed_store` (from `AuthorizationServerConfig`, which
    /// the live app sources from `tauri-shared-config.json`), NOT a hardcoded
    /// scope list: a regression that re-hardcodes the scopes here, letting
    /// them drift from the config, fails this test.
    #[test]
    fn seeds_the_host_app_s_client_with_the_configured_scopes() {
        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        let scopes = vec!["openid".to_string(), "fhirUser".to_string()];
        let store = open_and_seed_store(
            pool,
            &scopes,
            "fhir-ui-client",
            &url::Url::parse("https://ruth.relay.example").expect("origin"),
        )
        .expect("seed store");

        let seeded = store
            .read(|tx| tx.client_by_id(crate::WILDFLOWER_HOST_APP_CLIENT_ID))
            .expect("query client")
            .expect("the host app's client seeded under its constant id");
        assert_eq!(seeded.name, "Wildflower Host");
        assert_eq!(seeded.allowed_scopes, scopes);
    }

    /// The three clients seeding owns are server-defined, so a request is held
    /// to their registrations; every other client is trusted on first use.
    #[test]
    fn the_clients_seeding_owns_are_server_defined() {
        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        let store = open_and_seed_store(
            pool,
            &crate::default_host_app_client_scopes(),
            "fhir-ui-client",
            &url::Url::parse("https://ruth.relay.example").expect("origin"),
        )
        .expect("seed store");
        let source_of = |client_id: &str| {
            store
                .read(|tx| tx.client_by_id(client_id))
                .expect("query client")
                .map(|client| client.registration_source)
        };
        for client_id in [
            crate::WILDFLOWER_HOST_APP_CLIENT_ID,
            crate::BROWSER_SESSION_CLIENT_ID,
            "fhir-ui-client",
        ] {
            assert_eq!(
                source_of(client_id),
                Some(RegistrationSource::ServerDefined),
                "{client_id}"
            );
        }
        assert_eq!(
            source_of("growth_chart"),
            Some(RegistrationSource::TrustedOnFirstUse)
        );
    }

    /// With the standalone defaults, the host app's client may be granted
    /// `openid` alone: the Owner's authority is not the host client's.
    #[test]
    fn the_default_host_app_s_client_is_allowed_openid_only() {
        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        let store = open_and_seed_store(
            pool,
            &crate::default_host_app_client_scopes(),
            "fhir-ui-client",
            &url::Url::parse("https://ruth.relay.example").expect("origin"),
        )
        .expect("seed store");

        let seeded = store
            .read(|tx| tx.client_by_id(crate::WILDFLOWER_HOST_APP_CLIENT_ID))
            .expect("query client")
            .expect("the host app's client seeded");
        assert_eq!(seeded.allowed_scopes, vec!["openid".to_string()]);
    }

    /// The browser-session client is seeded as a public client with no redirect
    /// URIs and no grant type, allowed exactly the Owner's scopes, whatever the
    /// host app's client is allowed.
    #[test]
    fn seeds_the_browser_session_client_with_the_owner_s_scopes() {
        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        let store = open_and_seed_store(
            pool,
            &["openid".to_string()],
            "fhir-ui-client",
            &url::Url::parse("https://ruth.relay.example").expect("origin"),
        )
        .expect("seed store");

        let seeded = store
            .read(|tx| tx.client_by_id(crate::BROWSER_SESSION_CLIENT_ID))
            .expect("query client")
            .expect("the browser-session client seeded");
        assert_eq!(seeded.kind, ClientKind::Public);
        assert!(seeded.redirect_uris.is_empty());
        assert!(seeded.allowed_grant_types.is_empty());
        assert_eq!(seeded.allowed_scopes, crate::owner_scopes());
    }

    /// The UI's client is seeded under the configured id as a public client
    /// that may only return to this server's `/ui/callback` and only ask for
    /// `user/*.cruds`.
    #[test]
    fn seeds_the_fhir_ui_client_for_this_servers_origin() {
        let pool =
            wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
        let origin = url::Url::parse("https://ruth.relay.example").expect("origin");
        let store = open_and_seed_store(pool, &["openid".to_string()], "fhir-ui-client", &origin)
            .expect("seed store");

        let seeded = store
            .read(|tx| tx.client_by_id("fhir-ui-client"))
            .expect("query client")
            .expect("the UI client is seeded under the configured id");
        assert_eq!(
            (
                seeded.kind,
                seeded.redirect_uris,
                seeded.allowed_scopes,
                seeded.secret_hash
            ),
            (
                ClientKind::Public,
                vec![url::Url::parse("https://ruth.relay.example/ui/callback").expect("url")],
                vec!["user/*.cruds".to_string()],
                None
            )
        );
    }
}
