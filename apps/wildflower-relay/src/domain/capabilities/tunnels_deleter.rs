//! The delete capability — [`TunnelsDeleter`], for
//! `DELETE /api/tunnels/{name}`.

use crate::domain::{StoredTunnel, TunnelError, TunnelStore};

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
    /// stored, for [`Self::undo`].
    ///
    /// # Errors
    ///
    /// [`TunnelError::NotFound`] when no stored tunnel has the name;
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn delete(&self, name: &str) -> Result<StoredTunnel, TunnelError> {
        self.store.delete_tunnel(name)?.ok_or(TunnelError::NotFound)
    }

    /// Put back a tunnel [`Self::delete`] removed, when serving the change
    /// failed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Taken`] if a tunnel of that name has been stored since;
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn undo(&self, deleted: &StoredTunnel) -> Result<(), TunnelError> {
        if !self.store.insert_tunnel(deleted)? {
            return Err(TunnelError::Taken);
        }
        Ok(())
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
        let deleter = TunnelsDeleter::new(store);

        assert_eq!(deleter.delete("nobody").unwrap_err(), TunnelError::NotFound);
        assert_eq!(deleter.store.list_tunnels().unwrap().len(), 2);

        let deleted = deleter.delete("bob").unwrap();
        assert_eq!(deleted, stored_tunnel("bob"));
        assert_eq!(
            deleter.store.list_tunnels().unwrap(),
            [stored_tunnel("alice")]
        );
        assert_eq!(
            deleter.delete("bob").unwrap_err(),
            TunnelError::NotFound,
            "a deleted tunnel is gone"
        );

        deleter.undo(&deleted).unwrap();
        assert_eq!(deleter.store.list_tunnels().unwrap().len(), 2);
        assert_eq!(deleter.undo(&deleted).unwrap_err(), TunnelError::Taken);
    }
}
