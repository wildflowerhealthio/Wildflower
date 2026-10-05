//! The delete capability — [`TunnelsDeleter`], for
//! `DELETE /api/tunnels/{name}`.

use crate::domain::{StoredTunnel, TunnelError, TunnelSet, TunnelStore};

/// Removal — `DELETE /api/tunnels/{name}`. Holds the store, lifted from the
/// state.
pub(crate) struct TunnelsDeleter<S: TunnelStore> {
    store: S,
}

impl<S: TunnelStore> TunnelsDeleter<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Delete the tunnel named `name` from the store. Returns what was
    /// stored (for [`Self::undo`]) and `live` without it.
    ///
    /// # Errors
    ///
    /// [`TunnelError::NotFound`] when no live tunnel has the name, with
    /// nothing deleted; [`TunnelError::Infrastructure`] if the store write
    /// fails.
    pub(crate) fn delete(
        &self,
        live: &TunnelSet,
        name: &str,
    ) -> Result<(StoredTunnel, TunnelSet), TunnelError> {
        let mut next = live.clone();
        let deleted = next.remove(name).ok_or(TunnelError::NotFound)?;
        // A miss means the row is already gone, which is what deleting wants.
        self.store.delete_tunnel(name)?;
        Ok((deleted, next))
    }

    /// Put back a tunnel [`Self::delete`] removed, when serving the change
    /// failed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn undo(&self, deleted: &StoredTunnel) -> Result<(), TunnelError> {
        self.store.insert_tunnel(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};

    #[test]
    fn deleter_removes_a_tunnel_and_reports_an_unknown_name() {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        let live = TunnelSet::new(store.list_tunnels().unwrap()).unwrap();
        let deleter = TunnelsDeleter::new(store);

        assert_eq!(
            deleter.delete(&live, "nobody").unwrap_err(),
            TunnelError::NotFound
        );
        assert_eq!(deleter.store.list_tunnels().unwrap().len(), 2);

        let (deleted, next) = deleter.delete(&live, "bob").unwrap();
        assert_eq!(deleted, stored_tunnel("bob"));
        assert_eq!(
            deleter.store.list_tunnels().unwrap(),
            [stored_tunnel("alice")]
        );
        assert!(next.get("bob").is_none());
        assert!(next.get("alice").is_some());

        deleter.undo(&deleted).unwrap();
        assert_eq!(deleter.store.list_tunnels().unwrap().len(), 2);
    }
}
