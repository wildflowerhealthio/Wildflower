//! The [`RemotesDeleter`] capability — the `wildflower/Accounts.d` door to
//! removing a collector remote. Holds its `*_scopes()` mapping (read by both its
//! binding and [`grantable_collector_scopes`](super::grantable_collector_scopes)
//! so enforced and grantable can't drift) and its store-focused test.

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{RemoteError, RemotesStore};

/// The scope gating [`RemotesDeleter`] — `wildflower/Accounts.d`.
pub(crate) fn remotes_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::DELETE,
    )]
}

/// Delete a collector remote — `DELETE /collector/remotes/{id}`, gated by
/// `wildflower/Accounts.d`.
pub(crate) struct RemotesDeleter<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesDeleter<S> {
    /// Build the deleter over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesDeleter { store }
    }

    /// Remove a remote by id, or [`RemoteError::NotFound`] when no remote has it.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn delete(&self, id: &str) -> Result<(), RemoteError> {
        if self.store.delete(id)? {
            Ok(())
        } else {
            Err(RemoteError::NotFound { id: id.to_owned() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::test_support::seed;
    use crate::domain::test_fake::FakeRemotesStore;

    /// A deleter removes the row then reports the second delete as a miss.
    #[test]
    fn deleter_removes_then_misses() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let deleter = RemotesDeleter::new(store);
        assert_eq!(deleter.delete("r1"), Ok(()));
        assert!(matches!(
            deleter.delete("r1"),
            Err(RemoteError::NotFound { .. })
        ));
    }
}
