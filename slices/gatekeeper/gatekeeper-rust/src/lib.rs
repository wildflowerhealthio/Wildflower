pub mod config;
pub mod crypto_util;
pub mod db;
pub mod db_utils;
pub mod domain;
pub mod http;
pub mod seeding;

use anyhow::Context;
use chrono::Duration;

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
/// into the app's root router, the shared `AppState` needed to gate
/// emr-rust traffic, and the host owner token bound to `origin`.
pub struct Gatekeeper {
    pub router: axum::Router,
    pub state: AppState,
    pub host_owner_token: String,
}

/// Build the gatekeeper-rust HTTP surface. Runs idempotent bootstrap
/// (schema migrations, signing-key seed, first-party client seed), mints
/// the boot-time host owner token against `origin`, and returns:
///
///  - a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/access/*` (Owner-only via bearer JWT) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - the `AppState` the caller passes to
///    [`layer_router_with_gatekeeper_auth_gating`] to wrap emr-rust;
///  - the host owner token the caller ships to the WebView so the Owner
///    UI can call `/access/*` endpoints.
///
/// `origin` must match the issuer/audience the verifier derives from the
/// `Host:` header on loopback requests, e.g. `http://127.0.0.1:<port>`.
///
/// The whole surface is gated by the loopback middleware — non-loopback
/// peers receive 403 before any handler runs.
pub fn setup_gatekeeper(
    config: &GatekeeperConfig,
    origin: &str,
) -> anyhow::Result<Gatekeeper> {
    let store = seeding::open_and_seed_store(config)?;
    let host_owner_token =
        seeding::mint_host_owner_token(&store, origin, HOST_OWNER_TOKEN_TTL)
            .context("failed to mint host owner token")?;
    let state = AppState {
        store: store.clone(),
    };
    let router = http::router(state.clone());
    Ok(Gatekeeper {
        router,
        state,
        host_owner_token,
    })
}
