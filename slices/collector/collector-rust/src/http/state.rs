//! Shared HTTP state — just the store handle; the collector surface needs no
//! other host seams.

use crate::db::RemotesStore;

/// Shared state threaded through the collector handlers. Held in an `Arc` and
/// extracted via `State<Arc<CollectorState>>` per the tunnel-rust pattern.
pub struct CollectorState {
    /// The remotes store.
    pub(crate) store: RemotesStore,
}

impl CollectorState {
    #[must_use]
    pub fn new(store: RemotesStore) -> Self {
        Self { store }
    }
}
