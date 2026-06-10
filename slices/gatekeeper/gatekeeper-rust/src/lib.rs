pub mod bridge;
pub mod config;
pub mod crypto_util;
pub mod db;
pub mod db_utils;
pub mod domain;
pub mod http;
pub mod seeding;

use anyhow::Context;
use chrono::Duration;
use tokio::sync::watch;

pub use config::GatekeeperConfig;
pub use db::GatekeeperStore;
pub use http::{layer_router_with_gatekeeper_auth_gating, AppState};

/// `client_id` of the host application's first-party OAuth client. The host
/// uses this identity to mint Owner tokens for itself and to recognise its
/// own client registration during bootstrap.
pub const FIRST_PARTY_CLIENT_ID: &str = "wildflower-host";

/// OAuth scope that grants full Owner-level access to the gatekeeper's
/// `/access/*` admin surface.
pub const OWNER_SCOPE: &str = "owner";

/// Lifetime of the host owner token minted at boot.
const HOST_OWNER_TOKEN_TTL: Duration = Duration::hours(24);

/// Result of `setup_gatekeeper`: the public router that should be merged
/// into the app's root router and the shared `AppState` needed to gate
/// emr-rust traffic. The host owner token is published to the caller's
/// `watch::Sender` rather than returned, so the token never sits in a
/// field the caller might forward by accident.
pub struct Gatekeeper {
    pub router: axum::Router,
    pub state: AppState,
}

/// Build the gatekeeper-rust HTTP surface. Runs idempotent bootstrap
/// (schema migrations, signing-key seed, first-party client seed), mints
/// the boot-time host owner token against `origin`, and:
///
///  - publishes the host owner token on `token_tx` so subscribers (e.g.
///    the WebView bridge listener) observe it the moment it exists;
///  - returns a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/access/*` (Owner-only via bearer JWT) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - returns the `AppState` the caller passes to
///    [`layer_router_with_gatekeeper_auth_gating`] to wrap emr-rust.
///
/// `origin` must match the issuer/audience the verifier derives from the
/// `Host:` header on loopback requests, e.g. `http://127.0.0.1:<port>`.
///
/// The whole surface is gated by the loopback middleware — non-loopback
/// peers receive 403 before any handler runs.
pub fn setup_gatekeeper(
    config: &GatekeeperConfig,
    origin: &str,
    token_tx: &watch::Sender<Option<String>>,
) -> anyhow::Result<Gatekeeper> {
    let store = seeding::open_and_seed_store(config)?;
    let host_owner_token =
        seeding::mint_host_owner_token(&store, origin, HOST_OWNER_TOKEN_TTL)
            .context("failed to mint host owner token")?;
    token_tx
        .send(Some(host_owner_token))
        .context("token channel receiver dropped before host owner token issuance")?;
    let state = AppState {
        store: store.clone(),
    };
    let router = http::router(state.clone());
    Ok(Gatekeeper { router, state })
}
