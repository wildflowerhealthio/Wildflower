//! Idempotent first-boot seeding for the gatekeeper store: signing keys
//! and the first-party host client. Each `ensure_*` is safe to call on
//! every boot — they no-op when the relevant row already exists.

use anyhow::Context;
use chrono::{Duration, Utc};
use persistence_rust::{Connection, JsonColumn};
use thiserror::Error;

use crate::db_utils::GatekeeperStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::{FIRST_PARTY_CLIENT_ID, OWNER_SCOPE};

/// Wrap the shared `conn` in a gatekeeper store (applying migrations) and run
/// every idempotent first-boot seeding step — signing key, first-party client.
///
/// # Errors
///
/// Returns an error if the store cannot be created (migrations) or if seeding
/// the signing key or first-party client fails.
pub fn open_and_seed_store(conn: Connection) -> anyhow::Result<GatekeeperStore> {
    let store = GatekeeperStore::new(conn).context("failed to open gatekeeper store")?;
    ensure_some_active_signing_key(&store).context("failed to seed signing key")?;
    ensure_first_party_client(&store).context("failed to seed first-party client")?;
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

/// Register the `wildflower-host` first-party client if it isn't already in
/// the store. Idempotent — safe to call on every boot.
fn ensure_first_party_client(store: &GatekeeperStore) -> anyhow::Result<()> {
    if store
        .client_by_id(FIRST_PARTY_CLIENT_ID)
        .context("read first-party client")?
        .is_some()
    {
        return Ok(());
    }
    let client = Client {
        client_id: FIRST_PARTY_CLIENT_ID.to_string(),
        name: "Wildflower (host)".to_string(),
        kind: ClientKind::Public,
        redirect_uris: JsonColumn(vec![]),
        allowed_scopes: JsonColumn(vec![OWNER_SCOPE.to_string()]),
        allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .register_client(&client)
        .context("register first-party client")?;
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
pub(crate) fn mint_host_owner_token(
    store: &GatekeeperStore,
    origin: &str,
    ttl: Duration,
) -> Result<String, HostTokenError> {
    let key = store
        .active_signing_key()?
        .ok_or(HostTokenError::NoSigningKeys)?;
    let scope = [OWNER_SCOPE.to_string()];
    Ok(mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: FIRST_PARTY_CLIENT_ID,
            scope: &scope,
            ttl,
            origin,
            audience: None,
            patient: None,
        },
    )?)
}
