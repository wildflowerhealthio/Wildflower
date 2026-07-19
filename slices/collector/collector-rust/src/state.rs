//! The shared collector runtime state — the router state every handler is built
//! over, and the composition point that names the concrete [`SqliteRemotesStore`]
//! adapter. It lives at the crate root (not under [`crate::http`]) deliberately:
//! the scope-gated [`capabilities`](crate::domain::capabilities) in `domain/` are
//! built from it through the bindings below, and `domain/` must not depend on
//! `crate::http`.
//!
//! The capability-binding [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability)
//! impls live here too (see [`capability_bindings`]): they name the concrete
//! `SqliteRemotesStore` and lift the store handle out of the state, so the
//! generic, store-agnostic capabilities in `domain/` never mention a concrete
//! adapter. The `type …Cap` aliases the handlers name in `Scoped<…>` are
//! re-exported from here.

mod capability_bindings;

pub(crate) use capability_bindings::{
    RemotesCreatorCap, RemotesDeleterCap, RemotesEditorCap, RemotesReaderCap,
};

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
