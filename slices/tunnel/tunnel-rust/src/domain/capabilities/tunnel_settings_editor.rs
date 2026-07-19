//! The [`TunnelSettingsEditor`] capability — the `wildflower/TunnelSettings.u`
//! door to the singleton settings replace. Holds its `*_scopes()` mapping (read
//! by both its binding and
//! [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes) so enforced and
//! grantable can't drift) and its store-focused test.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{
    actions, SettingsUpdate, SettingsUpdateOutcome, TunnelDaemon, TunnelError, TunnelStore,
};

/// The scope gating [`TunnelSettingsEditor`] — `wildflower/TunnelSettings.u`.
pub(crate) fn tunnel_settings_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::TunnelSettings,
        Permission::UPDATE,
    )]
}

/// Replace the singleton tunnel settings — `PUT /tunnel`. Distinct from
/// [`TunnelSettingsReader`](super::TunnelSettingsReader) because replacing is a
/// `TunnelSettings.u` capability; a reader holding `Scoped<TunnelSettingsReader>`
/// structurally cannot write. Generic over the store port, holding the store +
/// daemon handles lifted from the state.
pub(crate) struct TunnelSettingsEditor<S: TunnelStore> {
    store: S,
    daemon: Arc<TunnelDaemon>,
}

impl<S: TunnelStore> TunnelSettingsEditor<S> {
    /// Build the editor over a store handle + the daemon, both lifted from the
    /// state.
    pub(crate) fn new(store: S, daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsEditor { store, daemon }
    }

    /// Compare-and-swap the settings under `expected_revision` — the gated store
    /// write. Returns the [`SettingsUpdateOutcome`] (applied or stale-revision
    /// conflict); the handler drives the supervisor via the daemon and renders
    /// the snapshot.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn replace(
        &self,
        expected_revision: i64,
        update: SettingsUpdate,
    ) -> Result<SettingsUpdateOutcome, TunnelError> {
        actions::replace_settings(&self.store, expected_revision, update)
    }

    /// The live daemon, for the handler to reconcile the supervisor, await
    /// verification, and fold the observed runtime into the wire snapshot.
    /// Acquired only after the scope gate, so it rides behind the same
    /// `TunnelSettings.u` check as the write.
    pub(crate) fn daemon(&self) -> &TunnelDaemon {
        &self.daemon
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::daemon;
    use crate::domain::RelaySettings;

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    /// The editor's gated write applies under the matching revision and bumps it,
    /// then conflicts (leaving state untouched) under a stale revision — the
    /// compare-and-swap the `PUT` gate now fronts.
    #[tokio::test]
    async fn editor_replace_applies_then_conflicts_on_a_stale_revision() {
        let store = crate::db::SqliteTunnelStore::open_in_memory().expect("store");
        let editor = TunnelSettingsEditor::new(store, daemon());

        let applied = editor
            .replace(
                0,
                SettingsUpdate {
                    public_host: Some("dev1.example.com".into()),
                    requested_running: true,
                    relay_settings: Some(relay()),
                },
            )
            .expect("write");
        let SettingsUpdateOutcome::Applied(settings) = applied else {
            panic!("expected Applied, got {applied:?}");
        };
        assert_eq!(settings.revision, 1);
        assert_eq!(settings.public_host.as_deref(), Some("dev1.example.com"));

        // A second writer still on revision 0 loses the CAS.
        let conflict = editor
            .replace(
                0,
                SettingsUpdate {
                    public_host: Some("evil.example.com".into()),
                    requested_running: false,
                    relay_settings: None,
                },
            )
            .expect("write");
        let SettingsUpdateOutcome::Conflict(current) = conflict else {
            panic!("expected Conflict, got {conflict:?}");
        };
        assert_eq!(current.revision, 1, "current row returned");
        assert_eq!(
            current.public_host.as_deref(),
            Some("dev1.example.com"),
            "the losing write left the settings untouched",
        );
    }
}
