//! The shared apps runtime state — the router state every handler is built over,
//! and the composition point that names the concrete [`SqliteAppsStore`] adapter.
//! It also holds the public origin every launch's `{origin}` resolves to and the
//! host-seam port that mints launch contexts.
//!
//! It lives at the crate root (not under [`crate::http`]) deliberately: the
//! scope-gated [`capabilities`](crate::domain::capabilities) in `domain/` are
//! built from it through the per-capability bindings in the parent
//! [`live_bindings`](super) module, and `domain/` must not depend on
//! `crate::http` (authorization-server/databases style; see
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`).

use std::sync::Arc;

use url::Url;

use crate::db::SqliteAppsStore;
use crate::ports::LaunchContextMinter;

/// Shared state threaded through the apps handlers. Holds the **concrete**
/// [`SqliteAppsStore`] adapter (not `Arc<dyn AppsStore>` or a generic): the port
/// abstraction is the [`crate::domain::AppsStore`] trait the capabilities are
/// generic over, so the state and axum wiring stay monomorphic. Held in an `Arc` and extracted via
/// `State<Arc<AppsState>>` (launch glue) or lifted into a `Scoped<…>` capability
/// (every data-touching admin handler) per the tunnel-rust / authorization-server-rust pattern.
pub struct AppsState {
    /// The apps store — serves the `app_registrations` registry.
    pub(crate) store: SqliteAppsStore,
    /// The server's public origin. Every launch resolves `{origin}` to it
    /// ([`Self::public_origin`]).
    pub(crate) public_origin: Url,
    /// Mints the SMART `launch` value a SMART app's launch URL carries (see
    /// [`LaunchContextMinter`]). The host wires an authorization-server-backed adapter;
    /// tests use a fake.
    pub(crate) launch_context_minter: Arc<dyn LaunchContextMinter>,
}

impl AppsState {
    #[must_use]
    pub fn new(
        store: SqliteAppsStore,
        public_origin: Url,
        launch_context_minter: Arc<dyn LaunchContextMinter>,
    ) -> Self {
        Self {
            store,
            public_origin,
            launch_context_minter,
        }
    }

    /// The public origin string for a launch's `{origin}` —
    /// e.g. `https://ruth.relay.wildflowerhealth.io` (no trailing slash).
    pub(crate) fn public_origin(&self) -> String {
        wildflowerhealthio_shared_structures::origin_string(&self.public_origin)
    }
}
