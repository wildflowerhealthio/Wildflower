//! The shared collector runtime state — the router state every handler is built
//! over, and the composition point that names the concrete [`SqliteRemotesStore`]
//! adapter. It lives at the crate root (not under [`crate::http`]) deliberately:
//! the scope-gated [`capabilities`](crate::domain::capabilities) in `domain/` are
//! built from it through the per-capability bindings in the parent
//! [`live_bindings`](super) module, and `domain/` must not depend on
//! `crate::http`.

use crate::db::SqliteRemotesStore;

/// Shared state threaded through the collector handlers and lifted into the
/// scope-gated capabilities. Holds the **concrete** [`SqliteRemotesStore`]
/// adapter (not `Arc<dyn RemotesStore>` or a generic): the port abstraction lives
/// in the domain the capabilities call, so the router state and axum wiring stay
/// monomorphic. Held in an `Arc` and extracted via `State<Arc<CollectorState>>`
/// only at the composition seam (the capability bindings) — handlers reach it
/// solely through a `Scoped<…>` capability.
pub struct CollectorState {
    /// The remotes store. Cheap to clone (the pool is an `Arc` inside), so each
    /// capability binding lifts a clone out of the state rather than sharing the
    /// whole state.
    pub(crate) store: SqliteRemotesStore,
}

impl CollectorState {
    #[must_use]
    pub fn new(store: SqliteRemotesStore) -> Self {
        Self { store }
    }
}
