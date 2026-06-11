use std::sync::Arc;

use crate::db::GatekeeperStore;

/// Shared state threaded through every gatekeeper handler. Opaque to
/// callers outside the crate — the host receives one from
/// [`crate::setup_gatekeeper`] and passes it back into
/// [`crate::layer_router_with_gatekeeper_auth_gating`] without looking
/// inside.
#[derive(Clone)]
pub struct AppState {
    pub(crate) store: GatekeeperStore,
    /// Configured origin, pinned at [`crate::setup_gatekeeper`]. Used as
    /// the JWT `iss`/`aud` at mint and the expected issuer/audience at
    /// verify — never re-derived per-request from attacker-controllable
    /// `Host`/`x-forwarded-host` headers.
    pub(crate) origin: Arc<str>,
}
