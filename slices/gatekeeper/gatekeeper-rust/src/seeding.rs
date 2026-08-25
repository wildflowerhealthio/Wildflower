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
use thiserror::Error;

use crate::db::SqliteGatekeeperStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
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
    granted_scopes: &[String],
    first_party_client_id: &str,
) -> anyhow::Result<SqliteGatekeeperStore> {
    let store = SqliteGatekeeperStore::new(pool).context("failed to open gatekeeper store")?;
    ensure_some_active_signing_key(&store).context("failed to seed signing key")?;
    ensure_first_party_client(&store, granted_scopes, first_party_client_id)
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
/// the host's `granted_scopes`, and its `client_id` matches
/// `first_party_client_id` (the live app sources both from
/// `tauri-shared-config.json`; see [`crate::default_local_granted_scopes`] /
/// [`crate::default_first_party_client_id`]), correcting a store seeded by an
/// older build (registration time and any admin disable are preserved).
fn ensure_first_party_client(
    store: &SqliteGatekeeperStore,
    granted_scopes: &[String],
    first_party_client_id: &str,
) -> anyhow::Result<()> {
    let client = Client {
        client_id: first_party_client_id.to_string(),
        name: "Wildflower (host)".to_string(),
        kind: ClientKind::Public,
        redirect_uris: vec![],
        allowed_scopes: granted_scopes.to_vec(),
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

/// The debug-only OAuth clients for the first-party apps' vite dev servers — the
/// gatekeeper half of `apps_rust::seed_dev_apps`.
///
/// The two first-party apps now ship as **cloud** rows served from
/// <https://wildflowerhealth.io> (apps migration `0005_first_party_apps_to_cloud`),
/// whose clients register an *absolute* Pages redirect URI. A debug build also
/// gets a self-hosted `<app>-dev` row pointing at the app's local vite dev server,
/// and that row needs its own client: the app-relative `"/"` redirect resolves
/// only through the host's [`SelfHostedRedirectResolver`](crate::SelfHostedRedirectResolver),
/// which looks the app up **by `client_id`** and requires the row it finds to be
/// self-hosted. So the dev client id must equal the dev app id — which is why
/// these are separate clients rather than extra redirect entries on the
/// production ones (adding `http://127.0.0.1:5190/` there would also mean
/// registering a plaintext loopback redirect on a client that a public website
/// uses).
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
            5190,
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
            5191,
        ),
        (
            "importer-app-dev",
            "Importer (Dev)",
            // Mirrors the production `importer-app` client's write-carrying set
            // (`apps/importer-web/src/config.ts`) — a dev build requests the same
            // scopes, and unlike the two viewers above the Importer writes.
            [
                "launch",
                "openid",
                "fhirUser",
                "system/DocumentReference.read",
                "system/DocumentReference.write",
                "system/Patient.write",
                "system/Observation.write",
            ]
            .as_slice(),
            5193,
        ),
    ];
    for (client_id, name, scopes, port) in dev_clients {
        use url::Url;

        let client = Client {
            client_id: client_id.to_string(),
            name: name.to_string(),
            kind: ClientKind::Public,
            // App-relative: resolved against the dev app's own loopback origin at
            // `/authorize` time, so the vite port lives in exactly one place (the
            // apps dev seed) instead of being duplicated here.
            redirect_uris: vec![
                RegisteredRedirectUri::AppRelative("/".to_string()),
                RegisteredRedirectUri::Absolute(
                    Url::parse(&format!("http://localhost:{}/", port)).unwrap(),
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

/// Failures while minting the host owner token at boot.
#[derive(Debug, Error)]
pub(crate) enum HostTokenError {
    /// Reading signing keys from the store failed.
    #[error("read signing keys from store")]
    Store(#[from] crate::domain::gatekeeper_error::GatekeeperError),
    /// No signing keys are present in the store — bootstrap has not run, or
    /// the database has been tampered with.
    #[error("no signing keys in store")]
    NoSigningKeys,
    /// [`crate::domain::token`] failed to sign the token; the wrapped error
    /// preserves whether it was a key-material or encoding failure.
    #[error("sign host owner token")]
    JwsSignFailed(#[from] MintError),
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
pub(crate) fn mint_host_owner_token(
    store: &SqliteGatekeeperStore,
    iss: &str,
    aud: &str,
    ttl: Duration,
    granted_scopes: &[String],
    first_party_client_id: &str,
) -> Result<String, HostTokenError> {
    let key = store
        .active_signing_key()?
        .ok_or(HostTokenError::NoSigningKeys)?;
    // The host owner token carries the host's granted scopes (by default the FHIR
    // and Wildflower full-access wildcards): it gates HFS's FHIR surface, and —
    // because those wildcards cover every per-resource scope the `Scoped<…>`
    // extractors require — it passes every gate on gatekeeper's `/access/*` admin
    // surface too. `setup_gatekeeper` asserts the granted set covers
    // `WILDFLOWER_WIDEST_SCOPES` before we reach here.
    Ok(mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: first_party_client_id,
            scope: granted_scopes,
            ttl,
            origin: iss,
            audience: Some(aud),
            patient: None,
            // Marks the one token allowed to authenticate via the canonical audience.
            is_host_owner: true,
        },
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
