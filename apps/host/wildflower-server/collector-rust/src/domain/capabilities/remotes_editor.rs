//! The [`RemotesEditor`] capability — the `wildflower/Accounts.u` door to
//! replacing a collector remote's `name` + `config`. Holds its `*_scopes()`
//! mapping (read by both its binding and
//! [`grantable_collector_scopes`](super::grantable_collector_scopes) so enforced
//! and grantable can't drift) and its store-focused tests.

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{required_config_tag, Remote, RemoteError, RemotesStore};

/// The scope gating [`RemotesEditor`] — `wildflower/Accounts.u`.
pub(crate) fn remotes_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::UPDATE,
    )]
}

/// Replace a collector remote's `name` + `config` — `PUT /collector/remotes/{id}`,
/// gated by `wildflower/Accounts.u`.
pub(crate) struct RemotesEditor<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesEditor<S> {
    /// Build the editor over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesEditor { store }
    }

    /// Full-replace a remote's `name` + `config` (re-denormalizing `tag` from the
    /// new `config._tag`; `id` and `added_at` are immutable), or
    /// [`RemoteError::NotFound`] on an unknown id / [`RemoteError::InvalidConfig`]
    /// on a config with no string `_tag`.
    ///
    /// # Errors
    ///
    /// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn update(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> Result<Remote, RemoteError> {
        let tag = required_config_tag(config)?;
        self.store
            .update(id, name, &tag, config)?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::{config, seed};
    use crate::domain::test_fake::FakeRemotesStore;

    /// An editor rewrites `name` + `config` on an existing remote, and reports an
    /// unknown id as `NotFound`.
    #[test]
    fn editor_updates_then_not_found_on_unknown() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let editor = RemotesEditor::new(store);
        let updated = editor
            .update("r1", "Renamed", &config("rexall"))
            .expect("update");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall", "tag re-denormalized");
        assert!(matches!(
            editor.update("ghost", "n", &config("fhir-r4")),
            Err(RemoteError::NotFound { .. }),
        ));
    }

    /// An update with a config carrying no string `_tag` is rejected as
    /// `InvalidConfig`.
    #[test]
    fn editor_rejects_a_config_without_a_string_tag() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let editor = RemotesEditor::new(store);
        assert!(matches!(
            editor.update("r1", "n", &serde_json::json!({ "rootUrl": "x" })),
            Err(RemoteError::InvalidConfig { .. }),
        ));
    }
}
