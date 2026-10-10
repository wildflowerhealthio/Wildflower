//! The [`RemotesReader`] capability — the `wildflower/Accounts.r` door to reading
//! collector remotes. Holds its `*_scopes()` mapping (read by both its binding
//! and [`grantable_collector_scopes`](super::grantable_collector_scopes) so
//! enforced and grantable can't drift) and its store-focused tests.

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{Remote, RemoteError, RemotesStore};

/// The scope gating [`RemotesReader`] — `wildflower/Accounts.r`. Reads require
/// `.r` (not merely authentication) because the returned `config` can carry the
/// origin's credentials. Shared by the capability's `FixedScopeCapability`
/// binding and [`grantable_collector_scopes`](super::grantable_collector_scopes)
/// so enforced and grantable can't drift.
pub(crate) fn remotes_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::READ,
    )]
}

/// Read access to collector remotes — `GET /collector/remotes[/{id}]`, gated by
/// `wildflower/Accounts.r`. Generic over the store port so it's unit-testable
/// against the fake; the binding instantiates it over the concrete
/// `SqliteRemotesStore`.
pub(crate) struct RemotesReader<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesReader { store }
    }

    /// Every remote, oldest first — the `GET /collector/remotes` catalogue.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] if the store read fails.
    pub(crate) fn list(&self) -> Result<Vec<Remote>, RemoteError> {
        self.store.list()
    }

    /// A single remote by id, or [`RemoteError::NotFound`] when absent.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store read fails.
    pub(crate) fn get(&self, id: &str) -> Result<Remote, RemoteError> {
        self.store
            .get(id)?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::seed;
    use crate::domain::test_fake::FakeRemotesStore;

    /// A reader over a fake store seeded with one remote lists it and fetches it
    /// by id, and reports an unknown id as `NotFound` — the capability reads
    /// through the store handle it holds.
    #[test]
    fn reader_lists_and_gets_through_the_store_handle() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let reader = RemotesReader::new(store);
        assert_eq!(reader.list().unwrap().len(), 1);
        assert_eq!(reader.get("r1").unwrap().name, "One");
        assert!(matches!(
            reader.get("ghost"),
            Err(RemoteError::NotFound { .. })
        ));
    }

    /// The reader lists rows in a total order — `added_at` then `id`. Both seeds
    /// share an `added_at`, so the `id` tiebreak ("a" < "b") fixes the order.
    #[test]
    fn reader_lists_remotes_in_a_total_order() {
        let store = FakeRemotesStore::default();
        seed(&store, "b", "B", "fhir-r4");
        seed(&store, "a", "A", "fhir-r4");
        let reader = RemotesReader::new(store);
        let ids: Vec<String> = reader.list().unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }
}
