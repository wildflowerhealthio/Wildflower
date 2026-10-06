//! The [`TunnelSettingsReader`] capability — the `wildflower/TunnelSettings.r`
//! door to the tunnel's state. Holds its `*_scopes()` mapping (read by both its
//! binding and [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes) so
//! enforced and grantable can't drift) and its test.

use std::sync::Arc;

use crate::domain::{TunnelDaemon, TunnelLiveness};
use scopes_rust::{Permission, Scope, WildflowerResource};

/// The scope gating [`TunnelSettingsReader`] — `wildflower/TunnelSettings.r`.
/// Shared by the capability's `FixedScopeCapability` binding and
/// [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes) so enforced and
/// grantable can't drift.
pub(crate) fn tunnel_settings_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::TunnelSettings,
        Permission::READ,
    )]
}

/// Read the tunnel's liveness — `GET /tunnel`. Holds the
/// [`TunnelDaemon`] lifted from the state (never `Arc<TunnelState>`).
pub(crate) struct TunnelSettingsReader {
    daemon: Arc<TunnelDaemon>,
}

impl TunnelSettingsReader {
    /// Build the reader over the daemon lifted from the state.
    pub(crate) fn new(daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsReader { daemon }
    }

    /// A snapshot of the tunnel's current liveness.
    pub(crate) fn liveness(&self) -> TunnelLiveness {
        self.daemon.liveness()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::daemon;
    use crate::domain::TunnelStatus;

    /// The reader reads the running daemon's liveness: dialing until a probe
    /// verifies.
    #[tokio::test]
    async fn reader_reads_the_daemon_s_liveness() {
        let reader = TunnelSettingsReader::new(daemon());
        assert_eq!(reader.liveness().status, TunnelStatus::Dialing);
    }
}
