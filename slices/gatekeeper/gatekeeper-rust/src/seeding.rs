//! First-boot seeding for the gatekeeper store: the signing key and the
//! first-party host client. Safe to call on every boot — the signing key is
//! inserted only when none exists (never rotated), and the first-party client is
//! *ensured* (re-applied as an upsert) so its definition always matches the
//! host's granted scopes, correcting any drift in a store created by an older
//! build.
//!
//! The bundled SMART sample-app clients (growth-chart, medication-viewer →
//! `my_web_app`, PRECISE-HBR) are seeded in SQL instead — migration
//! `008_seed_sample_clients.sql` — since they're static definitions a migration
//! can express. Only the runtime-derived seeds (the first-party client's scopes,
//! the generated signing key) stay here.

use anyhow::Context;
use chrono::{Duration, Utc};
use persistence_rust::{Connection, JsonColumn};
use thiserror::Error;

use crate::db::GatekeeperStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::FIRST_PARTY_CLIENT_ID;

/// Wrap the shared `conn` in a gatekeeper store (applying migrations, which
/// includes the SQL seed of the SMART sample-app clients) and run the
/// runtime-derived first-boot seeding steps — the signing key and the first-party
/// host client. Safe to call on every boot.
///
/// # Errors
///
/// Returns an error if the store cannot be created (migrations) or if any seeding
/// step fails.
pub fn open_and_seed_store(
    conn: Connection,
    granted_scopes: &[String],
) -> anyhow::Result<GatekeeperStore> {
    let store = GatekeeperStore::new(conn).context("failed to open gatekeeper store")?;
    ensure_some_active_signing_key(&store).context("failed to seed signing key")?;
    ensure_first_party_client(&store, granted_scopes)
        .context("failed to seed first-party client")?;
    Ok(store)
}

/// Generate and insert an active signing key if the table is empty;
/// otherwise leave the existing keys alone. Idempotent — safe to call on
/// every boot.
fn ensure_some_active_signing_key(store: &GatekeeperStore) -> anyhow::Result<()> {
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

/// Ensure the `wildflower-host` first-party client matches the code's
/// definition. Upserted on every boot so its `allowed_scopes` (and the rest of
/// its policy) always match the host's `granted_scopes` (the live app sources
/// these from `tauri-shared-config.json`; see
/// [`crate::default_local_granted_scopes`]), correcting a store seeded by an
/// older build (registration time and any admin disable are preserved).
fn ensure_first_party_client(
    store: &GatekeeperStore,
    granted_scopes: &[String],
) -> anyhow::Result<()> {
    let client = Client {
        client_id: FIRST_PARTY_CLIENT_ID.to_string(),
        name: "Wildflower (host)".to_string(),
        kind: ClientKind::Public,
        redirect_uris: JsonColumn(vec![]),
        allowed_scopes: JsonColumn(granted_scopes.to_vec()),
        allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .upsert_client(&client)
        .context("seed first-party client")?;
    Ok(())
}

/// Failures while minting the host owner token at boot.
#[derive(Debug, Error)]
pub(crate) enum HostTokenError {
    /// Reading signing keys from the store failed.
    #[error("read signing keys from store")]
    Sqlite(#[from] rusqlite::Error),
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
    store: &GatekeeperStore,
    iss: &str,
    aud: &str,
    ttl: Duration,
    granted_scopes: &[String],
) -> Result<String, HostTokenError> {
    let key = store
        .active_signing_key()?
        .ok_or(HostTokenError::NoSigningKeys)?;
    // The host owner token carries the host's granted scopes (by default the FHIR
    // and Wildflower full-access wildcards): it gates HFS's FHIR surface and —
    // since `require_owner_auth` checks coverage of every `WILDFLOWER_WIDEST_SCOPES`
    // entry — gatekeeper's `/access/*` admin surface too. `setup_gatekeeper`
    // asserts the granted set covers WIDEST before we reach here.
    Ok(mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: FIRST_PARTY_CLIENT_ID,
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
