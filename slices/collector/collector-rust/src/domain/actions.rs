//! Domain actions over the [`RemotesStore`] port — the seam the HTTP routes
//! call instead of touching a concrete store. Each function takes
//! `&impl RemotesStore`, so it runs against the `SQLite` adapter in production
//! and against an in-memory fake in tests, with no database or HTTP layer in the
//! way.
//!
//! Unlike tunnel's actions (thin relays over a settings surface with no semantic
//! error), collector's actions hold the slice's inner logic: they denormalize
//! `config._tag` into the stored `tag`, stamp a new remote's `added_at`, and map
//! the store's primitive absence/conflict signals (`Option` / `bool`) onto the
//! semantic [`RemoteError::NotFound`] / [`RemoteError::AlreadyExists`]. The port
//! stays free of those semantics; the routes stay a straight `?`.

use chrono::{SecondsFormat, Utc};

use crate::domain::{required_config_tag, Remote, RemoteError, RemotesStore};

/// Every remote, oldest first — the `GET /collector/remotes` catalogue.
///
/// # Errors
///
/// [`RemoteError::Infrastructure`] if the store read fails.
pub(crate) fn list_remotes(store: &impl RemotesStore) -> Result<Vec<Remote>, RemoteError> {
    store.list()
}

/// A single remote by id, or [`RemoteError::NotFound`] when absent — the
/// `GET /collector/remotes/{id}` read.
///
/// # Errors
///
/// [`RemoteError::NotFound`] when no remote has this id;
/// [`RemoteError::Infrastructure`] if the store read fails.
pub(crate) fn get_remote(store: &impl RemotesStore, id: &str) -> Result<Remote, RemoteError> {
    store
        .get(id)?
        .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
}

/// Create a remote: denormalize `config._tag` into `tag`, stamp `added_at`, and
/// insert. Returns [`RemoteError::AlreadyExists`] when the client-minted id is
/// already taken (the insert affected no row) rather than overwriting.
///
/// # Errors
///
/// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
/// [`RemoteError::AlreadyExists`] when the id is already taken;
/// [`RemoteError::Infrastructure`] if the store write fails.
pub(crate) fn create_remote(
    store: &impl RemotesStore,
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
        added_at: now_added_at(),
    };
    if store.insert(&remote)? {
        Ok(remote)
    } else {
        Err(RemoteError::AlreadyExists {
            id: remote.id.clone(),
        })
    }
}

/// Update a remote's `name` + `config` (re-denormalizing `tag` from the new
/// `config._tag`; `id` and `added_at` are immutable). Returns
/// [`RemoteError::NotFound`] when no remote has this id.
///
/// # Errors
///
/// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
/// [`RemoteError::NotFound`] when no remote has this id;
/// [`RemoteError::Infrastructure`] if the store write fails.
pub(crate) fn update_remote(
    store: &impl RemotesStore,
    id: &str,
    name: &str,
    config: &serde_json::Value,
) -> Result<Remote, RemoteError> {
    let tag = required_config_tag(config)?;
    store
        .update(id, name, &tag, config)?
        .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
}

/// Delete a remote by id, or [`RemoteError::NotFound`] when no remote has this
/// id.
///
/// # Errors
///
/// [`RemoteError::NotFound`] when no remote has this id;
/// [`RemoteError::Infrastructure`] if the store write fails.
pub(crate) fn delete_remote(store: &impl RemotesStore, id: &str) -> Result<(), RemoteError> {
    if store.delete(id)? {
        Ok(())
    } else {
        Err(RemoteError::NotFound { id: id.to_owned() })
    }
}

/// Now, as ISO-8601 UTC with milliseconds (e.g. `2026-06-17T14:29:22.363Z`) —
/// the encoding the TS `Schema.DateTimeUtc` round-trips and the seed migration
/// pins. Minted here (not in the route) so the whole create action is testable
/// against the fake store.
fn now_added_at() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::*;

    /// An in-memory [`RemotesStore`] modelling the real primitive semantics —
    /// `insert` reports a duplicate id as `false`, `get`/`update` report an
    /// absent id as `None`, `delete` reports a miss as `false` — with no diesel
    /// and no database. Lets the actions' semantic mapping be exercised
    /// directly; the `SQLite` adapter's own coverage lives in `crate::db`.
    #[derive(Default)]
    struct FakeRemotesStore {
        remotes: RefCell<HashMap<String, Remote>>,
    }

    impl RemotesStore for FakeRemotesStore {
        fn list(&self) -> Result<Vec<Remote>, RemoteError> {
            let mut remotes: Vec<Remote> = self.remotes.borrow().values().cloned().collect();
            remotes.sort_by(|a, b| (&a.added_at, &a.id).cmp(&(&b.added_at, &b.id)));
            Ok(remotes)
        }

        fn get(&self, id: &str) -> Result<Option<Remote>, RemoteError> {
            Ok(self.remotes.borrow().get(id).cloned())
        }

        fn insert(&self, remote: &Remote) -> Result<bool, RemoteError> {
            let mut remotes = self.remotes.borrow_mut();
            if remotes.contains_key(&remote.id) {
                return Ok(false);
            }
            remotes.insert(remote.id.clone(), remote.clone());
            Ok(true)
        }

        fn update(
            &self,
            id: &str,
            name: &str,
            tag: &str,
            config: &serde_json::Value,
        ) -> Result<Option<Remote>, RemoteError> {
            let mut remotes = self.remotes.borrow_mut();
            let Some(existing) = remotes.get_mut(id) else {
                return Ok(None);
            };
            existing.name = name.to_owned();
            existing.tag = tag.to_owned();
            existing.config = config.clone();
            Ok(Some(existing.clone()))
        }

        fn delete(&self, id: &str) -> Result<bool, RemoteError> {
            Ok(self.remotes.borrow_mut().remove(id).is_some())
        }
    }

    fn config(tag: &str) -> serde_json::Value {
        serde_json::json!({ "_tag": tag, "rootUrl": "https://x" })
    }

    fn seed(store: &FakeRemotesStore, id: &str) -> Remote {
        create_remote(
            store,
            id.to_owned(),
            format!("Remote {id}"),
            config("fhir-r4"),
        )
        .expect("seed create")
    }

    #[test]
    fn create_denormalizes_the_tag_stamps_added_at_and_returns_the_row() {
        let store = FakeRemotesStore::default();
        let created = seed(&store, "r1");
        assert_eq!(created.tag, "fhir-r4", "tag denormalized from config._tag");
        assert!(
            created.added_at.len() == 24
                && created.added_at.ends_with('Z')
                && created.added_at.contains('.'),
            "added_at is ISO-8601 UTC with milliseconds, got {}",
            created.added_at,
        );
        // The created row is what the store now holds.
        assert_eq!(get_remote(&store, "r1").unwrap(), created);
    }

    #[test]
    fn create_on_a_taken_id_is_already_exists_and_does_not_overwrite() {
        let store = FakeRemotesStore::default();
        let first = seed(&store, "dup");
        let clash = create_remote(
            &store,
            "dup".to_owned(),
            "Impostor".to_owned(),
            config("rexall"),
        );
        assert_eq!(
            clash,
            Err(RemoteError::AlreadyExists {
                id: "dup".to_owned()
            }),
        );
        assert_eq!(get_remote(&store, "dup").unwrap(), first, "row untouched");
    }

    #[test]
    fn create_rejects_a_config_without_a_string_tag() {
        let store = FakeRemotesStore::default();
        let outcome = create_remote(
            &store,
            "bad".to_owned(),
            "n".to_owned(),
            serde_json::json!({ "rootUrl": "x" }),
        );
        assert!(matches!(outcome, Err(RemoteError::InvalidConfig { .. })));
        assert!(
            matches!(get_remote(&store, "bad"), Err(RemoteError::NotFound { .. })),
            "nothing was stored",
        );
    }

    #[test]
    fn get_on_an_unknown_id_is_not_found() {
        let store = FakeRemotesStore::default();
        assert_eq!(
            get_remote(&store, "ghost"),
            Err(RemoteError::NotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn update_rewrites_mutable_fields_and_redenormalizes_the_tag() {
        let store = FakeRemotesStore::default();
        let created = seed(&store, "r1");
        let new_config = serde_json::json!({ "_tag": "rexall", "username": "u" });
        let updated = update_remote(&store, "r1", "Renamed", &new_config).expect("update");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall", "tag re-denormalized");
        assert_eq!(updated.config, new_config);
        assert_eq!(updated.added_at, created.added_at, "added_at is immutable");
    }

    #[test]
    fn update_on_an_unknown_id_is_not_found() {
        let store = FakeRemotesStore::default();
        assert_eq!(
            update_remote(&store, "ghost", "n", &config("fhir-r4")),
            Err(RemoteError::NotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn update_rejects_a_config_without_a_string_tag() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1");
        let outcome = update_remote(&store, "r1", "n", &serde_json::json!({ "rootUrl": "x" }));
        assert!(matches!(outcome, Err(RemoteError::InvalidConfig { .. })));
    }

    #[test]
    fn delete_removes_the_row_then_reports_a_miss() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1");
        assert_eq!(delete_remote(&store, "r1"), Ok(()));
        assert!(matches!(
            get_remote(&store, "r1"),
            Err(RemoteError::NotFound { .. })
        ));
        assert_eq!(
            delete_remote(&store, "r1"),
            Err(RemoteError::NotFound {
                id: "r1".to_owned()
            }),
            "second delete is a miss",
        );
    }

    #[test]
    fn list_returns_rows_in_a_total_order() {
        let store = FakeRemotesStore::default();
        // `a` is created first, so its `added_at` is `<=` `b`'s; on a same-millis
        // tie the id ("a" < "b") breaks it — either way the order is (a, b).
        seed(&store, "a");
        seed(&store, "b");
        let ids: Vec<String> = list_remotes(&store)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }
}
