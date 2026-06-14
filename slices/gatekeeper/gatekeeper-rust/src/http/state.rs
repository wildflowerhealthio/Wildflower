use crate::db_utils::GatekeeperStore;
use crate::http::SlidingWindowRateLimiter;

/// Shared state threaded through every gatekeeper handler. Opaque to
/// callers outside the crate — the host receives one from
/// [`crate::setup_gatekeeper`] and passes it back into
/// [`crate::layer_router_with_gatekeeper_auth_gating`] without looking
/// inside.
#[derive(Clone)]
pub struct AppState {
    pub(crate) store: GatekeeperStore,
    /// The HTTP-only loopback origin (e.g. `http://127.0.0.1:8080`), pinned
    /// from [`GatekeeperConfig`](crate::GatekeeperConfig) at
    /// [`crate::setup_gatekeeper`]. This is *only* the fallback that
    /// [`served_origin_for`](crate::http::served_origin_for) returns for a
    /// loopback request — handlers derive the per-request `iss`/`aud` from
    /// `served_origin_for(&headers, &state.loopback_origin)`, never from this
    /// value directly.
    pub(crate) loopback_origin: String,
    /// Per-IP throttle on the device-consent `user_code`-lookup path, shared
    /// (cheap `clone`) into the [`devices`](crate::http) router's rate-limit
    /// layer. Lives here so it's constructed once at
    /// [`setup_gatekeeper`](crate::setup_gatekeeper) and outlives any single
    /// request.
    pub(crate) user_code_rate_limiter: SlidingWindowRateLimiter,
}
