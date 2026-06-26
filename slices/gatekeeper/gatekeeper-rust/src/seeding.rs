//! First-boot seeding for the gatekeeper store: signing keys and the seeded
//! OAuth clients. Safe to call on every boot — the signing key is inserted only
//! when none exists (never rotated), and the seeded clients are *ensured*
//! (re-applied as an upsert) so their definition always matches the code,
//! correcting any drift in a store created by an older build.

use anyhow::Context;
use chrono::{Duration, Utc};
use persistence_rust::{Connection, JsonColumn};
use thiserror::Error;

use crate::db::GatekeeperStore;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::FIRST_PARTY_CLIENT_ID;

/// Wrap the shared `conn` in a gatekeeper store (applying migrations) and run
/// every first-boot seeding step — signing key, the first-party host client, and
/// the bundled SMART sample-app clients (growth-chart, PRECISE-HBR). Safe to call
/// on every boot.
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
    ensure_smart_growth_chart_client(&store)
        .context("failed to seed SMART growth-chart sample client")?;
    ensure_precise_hbr_client(&store).context("failed to seed PRECISE-HBR client")?;
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

/// Ensure the SMART growth-chart-app sample client matches the code's
/// definition: a public client (no secret, PKCE-only) with the standard SMART
/// App Launch scopes for a patient-context viewer. Upserted on every boot so an
/// older store's drifted definition is corrected (registration time and any
/// admin disable are preserved).
fn ensure_smart_growth_chart_client(store: &GatekeeperStore) -> anyhow::Result<()> {
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
        .upsert_client(&client)
        .context("seed growth-chart client")?;
    Ok(())
}

/// `client_id` the PRECISE-HBR Risk Calculator SMART app presents to
/// `/oauth/authorize` (a fixed UUID baked into its registration).
const PRECISE_HBR_CLIENT_ID: &str = "cc344727-6f90-496c-94fd-c7829aa9a51d";

/// Ensure the PRECISE-HBR Risk Calculator client matches the code's definition:
/// a public SMART app (no secret, PKCE-only) granted the patient-context read
/// scopes its risk calculation needs (conditions, medications, observations,
/// procedures). Upserted on every boot (registration time and any admin disable
/// preserved).
fn ensure_precise_hbr_client(store: &GatekeeperStore) -> anyhow::Result<()> {
    let client = Client {
        client_id: PRECISE_HBR_CLIENT_ID.to_string(),
        name: "PRECISE-HBR Risk Calculator".to_string(),
        kind: ClientKind::Public,
        redirect_uris: JsonColumn(vec![url::Url::parse(
            "https://hbr.alumicoin.cloud/callback",
        )
        .expect("PRECISE-HBR redirect URL is a hardcoded valid URL")]),
        // SMART App Launch context + the patient-context FHIR reads the risk
        // calculator pulls (demographics, observations, problems, medications,
        // procedures), in canonical v2 letter form.
        allowed_scopes: JsonColumn(vec![
            "openid".to_string(),
            "fhirUser".to_string(),
            "launch".to_string(),
            "profile".to_string(),
            "patient/Patient.rs".to_string(),
            "patient/Observation.rs".to_string(),
            "patient/Condition.rs".to_string(),
            "patient/MedicationRequest.rs".to_string(),
            "patient/Procedure.rs".to_string(),
        ]),
        allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    };
    store
        .upsert_client(&client)
        .context("seed PRECISE-HBR client")?;
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
/// `iss` is [`shared_structures_rust::CANONICAL_ISSUER`] (so HFS accepts
/// it), `aud` is the loopback origin (so gatekeeper's `require_auth`
/// middleware accepts it for WebView calls coming in over loopback).
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
        },
    )?)
}
