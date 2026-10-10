//! The [`RemotesCreator`] capability — the `wildflower/Accounts.c` door to
//! creating a collector remote. Holds its `*_scopes()` mapping (read by both its
//! binding and [`grantable_collector_scopes`](super::grantable_collector_scopes)
//! so enforced and grantable can't drift) and its store-focused tests.

use chrono::{SecondsFormat, Utc};
use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{required_config_tag, Remote, RemoteError, RemotesStore};

/// The scope gating [`RemotesCreator`] — `wildflower/Accounts.c`.
pub(crate) fn remotes_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::CREATE,
    )]
}

/// Create a collector remote — `POST /collector/remotes`, gated by
/// `wildflower/Accounts.c`. Separate from [`RemotesReader`](super::RemotesReader)
/// so a read handler structurally cannot create.
pub(crate) struct RemotesCreator<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesCreator<S> {
    /// Build the creator over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesCreator { store }
    }

    /// Store a new remote — denormalize `config._tag` into `tag`, stamp
    /// `added_at`, and insert. Returns [`RemoteError::AlreadyExists`] when the
    /// client-minted id is already taken (the insert affected no row) rather than
    /// overwriting.
    ///
    /// # Errors
    ///
    /// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
    /// [`RemoteError::AlreadyExists`] when the id is already taken;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn create(
        &self,
        id: String,
        name: String,
        config: serde_json::Value,
    ) -> Result<Remote, RemoteError> {
        let tag = required_config_tag(&config)?;
        let remote = Remote {
            id,
            name,
            tag,
            config,
            // ISO-8601 UTC with milliseconds (e.g. `2026-06-17T14:29:22.363Z`) —
            // the encoding the TS `Schema.DateTimeUtc` round-trips and the seed
            // migration pins.
            added_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if self.store.insert(&remote)? {
            Ok(remote)
        } else {
            Err(RemoteError::AlreadyExists {
                id: remote.id.clone(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::config;
    use crate::domain::test_fake::FakeRemotesStore;

    /// A creator inserts a fresh remote (denormalizing `tag`, stamping a
    /// millisecond-precision `added_at`) and reports a taken id as `AlreadyExists`.
    #[test]
    fn creator_inserts_then_conflicts_on_a_taken_id() {
        let creator = RemotesCreator::new(FakeRemotesStore::default());
        let created = creator
            .create("r1".to_owned(), "One".to_owned(), config("rexall"))
            .expect("create");
        assert_eq!(created.tag, "rexall", "tag denormalized from config._tag");
        assert!(
            created.added_at.len() == 24
                && created.added_at.ends_with('Z')
                && created.added_at.contains('.'),
            "added_at is ISO-8601 UTC with milliseconds, got {}",
            created.added_at,
        );
        assert_eq!(
            creator.create("r1".to_owned(), "Dup".to_owned(), config("fhir-r4")),
            Err(RemoteError::AlreadyExists {
                id: "r1".to_owned()
            }),
        );
    }

    /// A create with a config carrying no string `_tag` is rejected as
    /// `InvalidConfig` before anything is stored.
    #[test]
    fn creator_rejects_a_config_without_a_string_tag() {
        let creator = RemotesCreator::new(FakeRemotesStore::default());
        assert!(matches!(
            creator.create(
                "bad".to_owned(),
                "n".to_owned(),
                serde_json::json!({ "rootUrl": "x" }),
            ),
            Err(RemoteError::InvalidConfig { .. }),
        ));
    }
}
