//! The [`TunnelSettingsReader`] capability — the `wildflower/TunnelSettings.r`
//! door to the singleton settings read. Holds its `*_scopes()` mapping (read by
//! both its binding and [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes)
//! so enforced and grantable can't drift) and its store-focused test.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{TunnelDaemon, TunnelError, TunnelSettings, TunnelStore};

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

/// Read the singleton tunnel settings — `GET /tunnel`. Generic over the store
/// port so the store read is unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteTunnelStore`. Holds the store handle
/// and the [`TunnelDaemon`] lifted from the state (never `Arc<TunnelState>`) —
/// the daemon supplies the observed-runtime half of the snapshot the handler
/// renders.
pub(crate) struct TunnelSettingsReader<S: TunnelStore> {
    store: S,
    daemon: Arc<TunnelDaemon>,
}

impl<S: TunnelStore> TunnelSettingsReader<S> {
    /// Build the reader over a store handle + the daemon, both lifted from the
    /// state.
    pub(crate) fn new(store: S, daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsReader { store, daemon }
    }

    /// The current persisted settings — the gated store read.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store read fails.
    pub(crate) fn settings(&self) -> Result<TunnelSettings, TunnelError> {
        self.store.get_settings()
    }

    /// The live daemon, for the handler to fold the observed runtime into the
    /// wire snapshot. Acquired only after the scope gate, so it rides behind the
    /// same `TunnelSettings.r` check as the settings themselves.
    pub(crate) fn daemon(&self) -> &TunnelDaemon {
        &self.daemon
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::daemon;

    /// The reader's gated store read returns the persisted singleton — exercised
    /// against the real in-memory `SQLite` store (the same adapter the binding
    /// wires, so the store read path is covered end to end without a database
    /// file).
    #[tokio::test]
    async fn reader_settings_returns_the_persisted_snapshot() {
        let store = crate::db::SqliteTunnelStore::open_in_memory().expect("store");
        let reader = TunnelSettingsReader::new(store, daemon());
        let settings = reader.settings().expect("read");
        assert_eq!(settings.revision, 0);
        assert_eq!(settings.public_host, None);
        assert!(!settings.requested_running);
    }
}
