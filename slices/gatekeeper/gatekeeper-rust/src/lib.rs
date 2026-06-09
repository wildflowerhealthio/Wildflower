pub mod bootstrap;
pub mod config;
pub mod crypto;
pub mod error;
pub mod error_pages;
pub mod gate;
pub mod handlers;
pub mod loopback_gate;
pub mod origin;
pub mod page_paths;
pub mod require_auth;
pub mod store;
pub mod time;

use std::sync::Arc;

use anyhow::Context;
use axum::extract::Extension;
use axum::middleware;
use axum::Router;

pub use config::GatekeeperConfig;
pub use error::MintError;
pub use gate::gate;
pub use origin::{OriginProvider, RequestOriginProvider, SharedOriginProvider, DEFAULT_ORIGIN};
pub use require_auth::AppState;
pub use store::GatekeeperStore;

/// Result of `setup_gatekeeper`: the public router that should be merged
/// into the app's root router plus the shared `AppState` needed to gate
/// emr-rust traffic and mint owner tokens.
pub struct Gatekeeper {
    pub router: Router,
    pub state: AppState,
}

/// Build the gatekeeper-rust HTTP surface. Runs idempotent bootstrap
/// (schema migrations, signing-key seed, first-party client seed) and
/// returns:
///
///  - a `Router` whose routes are at `/.well-known/jwks.json`,
///    `/oauth/*`, and `/access/*` (Owner-only via bearer JWT) — the
///    slice owns its mount paths so the caller just `.merge()`s;
///  - the `AppState` the caller passes to [`gate`] to wrap emr-rust and
///    to [`mint_host_owner_token`] at boot.
///
/// The whole surface is gated by the loopback middleware — non-loopback
/// peers receive 403 before any handler runs.
pub fn setup_gatekeeper(config: &GatekeeperConfig) -> anyhow::Result<Gatekeeper> {
    let store = GatekeeperStore::open(&config.db_file_path)
        .with_context(|| format!("failed to open gatekeeper sqlite at {:?}", config.db_file_path))?;
    bootstrap::seed_signing_key(&store).context("failed to seed signing key")?;
    bootstrap::seed_first_party_client(&store).context("failed to seed first-party client")?;

    let origin: SharedOriginProvider = Arc::new(RequestOriginProvider);
    let state = AppState {
        store: store.clone(),
        origin,
    };

    let well_known = Router::new().nest("/.well-known", handlers::jwks::router());
    let oauth = handlers::oauth::router();
    let access = Router::new()
        .merge(handlers::access_management::router())
        .merge(handlers::oauth_consent::router())
        .merge(handlers::devices::router())
        .layer(middleware::from_fn(require_auth::require_owner_auth));

    let router = Router::new()
        .merge(well_known)
        .nest("/oauth", oauth)
        .nest("/access", access)
        .layer(middleware::from_fn(loopback_gate::loopback_gate))
        .layer(Extension(state.clone()));

    Ok(Gatekeeper { router, state })
}

/// Mint an Owner-scoped access token for `wildflower-host`, the
/// first-party client. The Tauri host calls this after `setup_gatekeeper`
/// and hands the resulting token to the WebView via the navigation
/// bridge so the Owner UI can call `/access/*` endpoints.
pub fn mint_host_owner_token(
    state: &AppState,
    origin: &str,
    ttl_secs: i64,
) -> Result<String, MintError> {
    bootstrap::mint_host_owner_token(&state.store, origin, ttl_secs)
}
