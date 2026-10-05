//! The in-memory [`TunnelStore`] fake the
//! [`capabilities`](crate::domain::capabilities) unit tests drive, plus the
//! [`stored_tunnel`] builder they (and the `db` and registry tests) seed
//! with. Modelling the real primitive semantics —
//! `insert_tunnel` fails a duplicate name as
//! [`TunnelError::Infrastructure`] (the primary-key violation),
//! `delete_tunnel` reports a miss as `false`, `list_tunnels` is by name — it
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

    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<(), TunnelError> {
        let mut tunnels = self.tunnels.borrow_mut();
        if tunnels.contains_key(&stored.tunnel.name) {
            return Err(TunnelError::infrastructure(
                "tunnel insert failed",
                format!("name={} already exists", stored.tunnel.name),
            ));
        }
        tunnels.insert(stored.tunnel.name.clone(), stored.clone());
        Ok(())
    }

    fn delete_tunnel(&self, name: &str) -> Result<bool, TunnelError> {
        Ok(self.tunnels.borrow_mut().remove(name).is_some())
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
