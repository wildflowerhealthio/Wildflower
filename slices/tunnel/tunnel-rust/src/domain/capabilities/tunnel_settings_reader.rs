//! The [`TunnelSettingsReader`] capability — the `wildflower/TunnelSettings.r`
//! door to the tunnel's state. Holds its `*_scopes()` mapping (read by both its
//! binding and [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes) so
//! enforced and grantable can't drift) and its test.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};
use shared_structures_rust::tunnel_service::TunnelLiveness;

use crate::domain::TunnelDaemon;

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

/// Read the tunnel's liveness and public host — `GET /tunnel`. Holds the
/// [`TunnelDaemon`] lifted from the state (never `Arc<TunnelState>`).
pub(crate) struct TunnelSettingsReader {
    daemon: Arc<TunnelDaemon>,
}

impl TunnelSettingsReader {
    /// Build the reader over the daemon lifted from the state.
    pub(crate) fn new(daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsReader { daemon }
    }

    /// The bare public host the relay serves the server at.
    pub(crate) fn public_host(&self) -> &str {
        self.daemon.public_host()
    }

    /// A snapshot of the tunnel's current liveness.
    pub(crate) fn liveness(&self) -> TunnelLiveness {
        self.daemon.liveness()
    }
}

#[cfg(test)]
mod tests {
    use shared_structures_rust::tunnel_service::TunnelStatus;

    use super::*;
    use crate::domain::capabilities::test_support::daemon;

    /// The reader reads the running daemon: its public host, and its liveness,
    /// dialing on the loopback fallback until a probe verifies.
    #[tokio::test]
    async fn reader_reads_the_daemon_s_public_host_and_liveness() {
        let reader = TunnelSettingsReader::new(daemon());
        assert_eq!(reader.public_host(), "dev1.example.com");
        let liveness = reader.liveness();
        assert_eq!(liveness.status, TunnelStatus::Dialing);
        assert_eq!(liveness.origin, "http://127.0.0.1:8080");
    }
}
