//! Shared HTTP state

use crate::db::SqliteTunnelStore;
use crate::domain::TunnelDaemon;

/// Shared state threaded through the tunnel handlers. Holds the **concrete**
/// [`SqliteTunnelStore`] adapter (not `Arc<dyn TunnelStore>` or a generic): the
/// port abstraction lives in the domain `actions` the handlers call, so the HTTP
/// state and axum wiring stay monomorphic.
pub struct TunnelState {
    pub(crate) store: SqliteTunnelStore,
    pub(crate) daemon: TunnelDaemon,
}
