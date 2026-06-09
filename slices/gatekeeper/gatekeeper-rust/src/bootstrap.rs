use anyhow::Context;
use chrono::{Duration, Utc};

use crate::crypto::jwt::{mint_access_token, MintArgs};
use crate::crypto::signing_key;
use crate::error::MintError;
use crate::store::client::{Client, ClientKind};
use crate::store::types::Json;
use crate::store::GatekeeperStore;

pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";
pub const OWNER_SCOPE: &str = "owner";

pub fn seed_signing_key(store: &GatekeeperStore) -> anyhow::Result<()> {
    let existing = store.all_signing_keys().context("read signing keys")?;
    if !existing.is_empty() {
        return Ok(());
    }
    let mut key = signing_key::generate().context("generate signing key")?;
    key.is_active = true;
    store
        .insert_signing_key(&key)
        .context("insert signing key")?;
    Ok(())
}

pub fn seed_first_party_client(store: &GatekeeperStore) -> anyhow::Result<()> {
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
        redirect_uris: Json(vec![]),
        allowed_scopes: Json(vec![OWNER_SCOPE.to_string()]),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .register_client(&client)
        .context("register first-party client")?;
    Ok(())
}

pub fn mint_host_owner_token(
    store: &GatekeeperStore,
    origin: &str,
    ttl: Duration,
) -> Result<String, MintError> {
    let active = store.active_signing_key()?;
    let all = store.all_signing_keys()?;
    let key = active
        .or_else(|| all.into_iter().next())
        .ok_or(MintError::NoSigningKeys)?;
    let scope = vec![OWNER_SCOPE.to_string()];
    mint_access_token(
        &key,
        MintArgs {
            client_id: FIRST_PARTY_CLIENT_ID,
            scope: &scope,
            ttl,
            origin,
            audience: None,
            patient: None,
        },
    )
    .map_err(|e| MintError::JwtSign(e.to_string()))
}
