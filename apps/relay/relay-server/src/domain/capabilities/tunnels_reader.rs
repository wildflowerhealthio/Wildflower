//! The read capability — [`TunnelsReader`], for `GET /api/tunnels`.

use crate::domain::{StoredTunnel, TunnelError, TunnelStore};
use crate::settings::FrontSettings;

/// Read access to the tunnels — `GET /api/tunnels`. Generic over the store
/// port so the read is exercised against the in-memory fake.
pub(crate) struct TunnelsReader<S: TunnelStore> {
    store: S,
    front: FrontSettings,
}

impl<S: TunnelStore> TunnelsReader<S> {
    pub(crate) fn new(store: S, front: FrontSettings) -> Self {
        Self { store, front }
    }

    /// Every tunnel, by name.
    pub(crate) fn list(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
        self.store.list_tunnels()
    }

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    pub(crate) fn public_host(&self, name: &str) -> String {
        self.front.public_host(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::test_support::settings;

    #[test]
    fn reader_lists_through_the_store_by_name() {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("carol")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        let front = settings(std::path::Path::new("/nonexistent"), None).front;
        let reader = TunnelsReader::new(store, front);
        assert_eq!(
            reader.list().unwrap(),
            [stored_tunnel("bob"), stored_tunnel("carol")]
        );
        assert_eq!(reader.public_host("bob"), "bob.relay.example.com");
    }
}
