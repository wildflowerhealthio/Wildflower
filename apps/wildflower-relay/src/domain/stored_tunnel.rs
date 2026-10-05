//! [`StoredTunnel`] — a tunnel created through the admin API, as the
//! [`TunnelStore`](crate::domain::TunnelStore) keeps it.

use crate::settings::Tunnel;

/// One stored tunnel: its name and token, who it belongs to and when it was
/// created. Tunnels from `WILDFLOWER_RELAY_TUNNELS` are never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTunnel {
    pub tunnel: Tunnel,
    /// Who the tunnel belongs to.
    pub email: String,
    /// Unix epoch seconds.
    pub created_at: i64,
}
