//! Shared HTTP state — the store handle plus the loopback origin used to
//! build launch URLs.

use crate::db::AppsStore;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    pub(crate) store: AppsStore,
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the
    /// tunnel is down (and, until the launch handler grows a real tunnel
    /// seam, always). `LaunchApp` redirects to this prefix; `requiresTunnel`
    /// launches add `?tunnel=unavailable` so the SPA can surface a banner.
    pub(crate) loopback_origin: String,
}

impl AppsState {
    pub fn new(store: AppsStore, loopback_origin: impl Into<String>) -> Self {
        Self {
            store,
            loopback_origin: loopback_origin.into(),
        }
    }
}
