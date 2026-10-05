//! The in-memory [`TunnelStore`] fake the
//! [`capabilities`](crate::domain::capabilities) unit tests drive, plus the
//! [`stored_tunnel`] builder they (and the `db` and registry tests) seed
//! with. Modelling the real primitive semantics — `insert_tunnel` reports a
//! name already stored as `false` (the primary key), `delete_tunnel` returns
//! the removed tunnel or `None` on a miss, `list_tunnels` is by name — it
//! keeps tunnels with no diesel and no database. The `SQLite` adapter's own
//! coverage lives in `crate::db`.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::domain::{StoredTunnel, Tunnel, TunnelError, TunnelStore};
use crate::settings::Secret;

#[derive(Default)]
pub(crate) struct FakeTunnelStore {
    tunnels: RefCell<BTreeMap<String, StoredTunnel>>,
}

impl TunnelStore for FakeTunnelStore {
    fn list_tunnels(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
        Ok(self.tunnels.borrow().values().cloned().collect())
    }

    fn contains_tunnel(&self, name: &str) -> Result<bool, TunnelError> {
        Ok(self.tunnels.borrow().contains_key(name))
    }

    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<bool, TunnelError> {
        let mut tunnels = self.tunnels.borrow_mut();
        if tunnels.contains_key(&stored.tunnel.name) {
            return Ok(false);
        }
        tunnels.insert(stored.tunnel.name.clone(), stored.clone());
        Ok(true)
    }

    fn delete_tunnel(&self, name: &str) -> Result<Option<StoredTunnel>, TunnelError> {
        Ok(self.tunnels.borrow_mut().remove(name))
    }
}

/// A stored tunnel named `name`, with a token and email derived from it.
pub(crate) fn stored_tunnel(name: &str) -> StoredTunnel {
    StoredTunnel {
        tunnel: Tunnel {
            name: name.to_owned(),
            token: Secret::new(format!("{name}-token")),
        },
        email: format!("{name}@example.com"),
        created_at: 1_700_000_000,
    }
}
