//! Shared HTTP state

use crate::db::TunnelStore;
use crate::domain::TunnelDaemon;

/// Shared state threaded through the tunnel handlers.
pub struct TunnelState {
    pub(crate) store: TunnelStore,
    pub(crate) daemon: TunnelDaemon,
}
