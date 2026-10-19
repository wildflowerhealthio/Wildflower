//! The [`LiveConnectionTotalsReader`] binding — lists the hourly connection
//! totals through the concrete `SqliteTunnelStore`, merged with the counts
//! not flushed yet. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use super::state::TunnelRegistry;
use super::{on_blocking, AdminCapability};
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::ConnectionTotalsReader;
use crate::domain::{HourlyTotals, TunnelError};
use crate::site::signature::unix_now;

/// Read the hourly totals — `Admin<LiveConnectionTotalsReader>` in the
/// totals handler.
pub(crate) struct LiveConnectionTotalsReader {
    reader: Arc<ConnectionTotalsReader<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl AdminCapability for LiveConnectionTotalsReader {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            reader: Arc::new(ConnectionTotalsReader::new(state.store.clone())),
            registry: state,
        }
    }
}

impl LiveConnectionTotalsReader {
    /// Every hour of the last 30 days with any count, oldest first (see
    /// [`ConnectionTotalsReader::list`]). It reads while no flush runs, so
    /// each count is either pending or stored, never both or neither.
    pub(crate) async fn list(&self) -> Result<Vec<HourlyTotals>, TunnelError> {
        let _flushing = self.registry.totals_flush.lock().await;
        let pending = self.registry.outcomes.pending();
        let reader = Arc::clone(&self.reader);
        on_blocking(move || {
            reader.list(&pending, || {
                unix_now().map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
            })
        })
        .await
    }
}
