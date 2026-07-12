//! Shared HTTP state — just the store handle; the collector surface needs no
//! other host seams.

use crate::db::SqliteRemotesStore;

/// Shared state threaded through the collector handlers. Holds the **concrete**
/// [`SqliteRemotesStore`] adapter (not `Arc<dyn RemotesStore>` or a generic):
/// the port abstraction lives in the domain `actions` the handlers call, so the
/// HTTP state and axum wiring stay monomorphic. Held in an `Arc` and extracted
/// via `State<Arc<CollectorState>>` per the tunnel-rust pattern.
pub struct CollectorState {
    /// The remotes store.
    pub(crate) store: SqliteRemotesStore,
}

impl CollectorState {
    #[must_use]
    pub fn new(store: SqliteRemotesStore) -> Self {
        Self { store }
    }
}
