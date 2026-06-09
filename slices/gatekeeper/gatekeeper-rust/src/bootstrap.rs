use crate::crypto::jwt::{mint_access_token, MintArgs};
use crate::crypto::signing_key;
use crate::error::{MintError, SetupError};
use crate::store::client::{ClientKind, ClientRow};
use crate::store::GatekeeperStore;
use crate::time;

pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";
pub const OWNER_SCOPE: &str = "owner";

pub async fn seed_signing_key(store: &GatekeeperStore) -> Result<(), SetupError> {
    let existing = store.all_signing_keys().await?;
    if !existing.is_empty() {
        return Ok(());
    }
    let key = signing_key::generate()?;
    store.insert_signing_key(key, true).await?;
    Ok(())
}

pub async fn seed_first_party_client(store: &GatekeeperStore) -> Result<(), SetupError> {
    if store.client_by_id(FIRST_PARTY_CLIENT_ID).await?.is_some() {
        return Ok(());
    }
    let registered_at = time::to_iso(time::now());
    store
        .register_client(ClientRow {
            client_id: FIRST_PARTY_CLIENT_ID.to_string(),
            name: "Wildflower (host)".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![],
            allowed_scopes: vec![OWNER_SCOPE.to_string()],
            secret_hash: None,
            registered_at,
            disabled_at: None,
        })
        .await?;
    Ok(())
}

pub async fn mint_host_owner_token(
    store: &GatekeeperStore,
    origin: &str,
    ttl_secs: i64,
) -> Result<String, MintError> {
    let active = store.active_signing_key().await?;
    let all = store.all_signing_keys().await?;
    let key = active.or_else(|| all.into_iter().next()).ok_or(MintError::NoSigningKeys)?;
    let scope = vec![OWNER_SCOPE.to_string()];
    mint_access_token(
        &key,
        MintArgs {
            client_id: FIRST_PARTY_CLIENT_ID,
            scope: &scope,
            ttl_secs,
            origin,
            audience: None,
            patient: None,
        },
    )
    .map_err(|e| MintError::JwtSign(e.to_string()))
}
