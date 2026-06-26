//! Idempotent first-boot seeding for the gatekeeper store: signing keys
//! and the first-party host client. Each `ensure_*` is safe to call on
//! every boot — they no-op when the relevant row already exists.

use anyhow::Context;
use chrono::{Duration, Utc};
use persistence_rust::{Connection, JsonColumn};
use thiserror::Error;

use crate::db::GatekeeperStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::FIRST_PARTY_CLIENT_ID;
use scopes_rust::{FULL_FHIR_ACCESS_SCOPE, OWNER_SCOPE};

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
    ensure_smart_growth_chart_client(&store)
        .context("failed to seed SMART growth-chart sample client")?;
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

/// `client_id` the SMART growth-chart-app sample at
/// [examples.smarthealthit.org](https://examples.smarthealthit.org/growth-chart-app/)
/// sends to `/oauth/authorize`. Pre-registered so the launch flow doesn't
/// fail with `unknown_client` for the demo. If the actual sample sends a
/// different identifier (the demo's config can be edited at boot time),
/// the e2e run will surface the mismatch in the rejection log and we
/// adjust here.
const GROWTH_CHART_CLIENT_ID: &str = "growth_chart";

/// Register the SMART growth-chart-app sample client if it isn't already
/// in the store. Public client (no secret, PKCE-only) with the standard
/// SMART App Launch scopes for a patient-context viewer. Idempotent.
fn ensure_smart_growth_chart_client(store: &GatekeeperStore) -> anyhow::Result<()> {
    if store
        .client_by_id(GROWTH_CHART_CLIENT_ID)
        .context("read growth-chart client")?
        .is_some()
    {
        return Ok(());
    }
    let client = Client {
        client_id: GROWTH_CHART_CLIENT_ID.to_string(),
        name: "SMART Growth Chart (sample)".to_string(),
        kind: ClientKind::Public,
        // examples.smarthealthit.org redirects back to the app's index
        // after the OAuth dance; allowlist that exact URL so a spec'd
        // SMART app callback is accepted.
        redirect_uris: JsonColumn(vec![url::Url::parse(
            "https://examples.smarthealthit.org/growth-chart-app/",
        )
        .expect("growth-chart-app redirect URL is a hardcoded valid URL")]),
        // The classic SMART App Launch scope set for a patient-context
        // app: OIDC identity + launch context + patient FHIR read/search +
        // refresh-token. Wildcard `patient/*.rs` covers narrower per-type
        // requests via the consent intersection's wildcard support.
        allowed_scopes: JsonColumn(vec![
            "openid".to_string(),
            "profile".to_string(),
            "fhirUser".to_string(),
            "launch".to_string(),
            "launch/patient".to_string(),
            "patient/Observation.read".to_string(),
            "patient/Patient.read".to_string(),
            "offline_access".to_string(),
        ]),
        allowed_grant_types: JsonColumn(vec![
            AllowedGrantType::AuthorizationCode,
            AllowedGrantType::RefreshToken,
        ]),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .register_client(&client)
        .context("register growth-chart client")?;
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
        allowed_scopes: JsonColumn(vec![
            OWNER_SCOPE.to_string(),
            FULL_FHIR_ACCESS_SCOPE.to_string(),
        ]),
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
///
/// `iss` is [`shared_structures_rust::CANONICAL_ISSUER`] (so HFS accepts
/// it), `aud` is the loopback origin (so gatekeeper's `require_auth`
/// middleware accepts it for WebView calls coming in over loopback).
pub(crate) fn mint_host_owner_token(
    store: &GatekeeperStore,
    iss: &str,
    aud: &str,
    ttl: Duration,
) -> Result<String, HostTokenError> {
    let key = store
        .active_signing_key()?
        .ok_or(HostTokenError::NoSigningKeys)?;
    // Both scopes go in: OWNER_SCOPE gates gatekeeper's admin surface,
    // FULL_FHIR_ACCESS_SCOPE gates HFS's FHIR surface. The token presents
    // both to satisfy each ring's check.
    let scope = [OWNER_SCOPE.to_string(), FULL_FHIR_ACCESS_SCOPE.to_string()];
    Ok(mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: FIRST_PARTY_CLIENT_ID,
            scope: &scope,
            ttl,
            origin: iss,
            audience: Some(aud),
            patient: None,
        },
    )?)
}
