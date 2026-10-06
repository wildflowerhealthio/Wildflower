//! The shared request-log runtime state — the router state every handler is
//! built over, and the composition point that names the concrete
//! [`SqliteRequestLogStore`] adapter. It lives at the crate root (not under
//! [`crate::http`]) deliberately: the scope-gated
//! [`capabilities`](crate::domain::capabilities) in `domain/` are built from it
//! through the binding in the parent [`live_bindings`](super) module, and
//! `domain/` must not depend on `crate::http`.

use crate::db::SqliteRequestLogStore;

/// Shared state threaded through the request-log handlers and lifted into the
/// scope-gated capability. Holds the **concrete** [`SqliteRequestLogStore`]
/// adapter: the port abstraction lives in the domain the capability calls, so
/// the router state and axum wiring stay monomorphic. Handlers reach it solely
/// through a `Scoped<…>` capability.
pub struct RequestLogState {
    /// The request-log store. Cheap to clone (the pool is an `Arc` inside), so
    /// the binding lifts a clone out of the state rather than sharing the whole
    /// state.
    pub(crate) store: SqliteRequestLogStore,
}

impl RequestLogState {
    #[must_use]
    pub fn new(store: SqliteRequestLogStore) -> Self {
        Self { store }
    }
}
