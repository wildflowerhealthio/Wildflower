//! The in-memory [`TunnelStore`] fake the
//! [`capabilities`](crate::domain::capabilities) unit tests drive, plus the
//! [`stored_tunnel`] builder they (and the `db` and registry tests) seed
//! with. Modelling the real primitive semantics — `insert_tunnel` reports a
//! name already stored as `false` (the primary key), `delete_tunnel` returns
//! the removed tunnel or `None` on a miss, `list_tunnels` is by name — it
//! keeps tunnels with no diesel and no database. It is the
//! [`ClaimCodeStore`] fake too, keeping at most one code per tunnel as the
//! database's primary key does, and deleting a tunnel's code with it as its
//! `ON DELETE CASCADE` does. The `SQLite` adapter's own coverage
//! lives in `crate::db`.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::domain::{
    ClaimCodeHash, ClaimCodeStore, StoredClaimCode, StoredTunnel, Tunnel, TunnelError, TunnelStore,
};
use crate::settings::Secret;

#[derive(Default)]
pub(crate) struct FakeTunnelStore {
    tunnels: RefCell<BTreeMap<String, StoredTunnel>>,
    claim_codes: RefCell<BTreeMap<ClaimCodeHash, StoredClaimCode>>,
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
        let deleted = self.tunnels.borrow_mut().remove(name);
        self.claim_codes
            .borrow_mut()
            .retain(|_, stored| stored.tunnel_name != name);
        Ok(deleted)
    }
}

impl ClaimCodeStore for FakeTunnelStore {
    fn replace_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError> {
        if !self.tunnels.borrow().contains_key(&stored.tunnel_name) {
            return Err(TunnelError::infrastructure(
                "storing the claim code failed",
                "FOREIGN KEY constraint failed",
            ));
        }
        let mut claim_codes = self.claim_codes.borrow_mut();
        if claim_codes.contains_key(&stored.code_hash) {
            return Ok(false);
        }
        claim_codes.retain(|_, outstanding| outstanding.tunnel_name != stored.tunnel_name);
        claim_codes.insert(stored.code_hash, stored.clone());
        Ok(true)
    }

    fn take_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError> {
        let mut claim_codes = self.claim_codes.borrow_mut();
        match claim_codes.get(code_hash) {
            Some(stored) if stored.expires_at > now => {}
            _ => return Ok(None),
        }
        let taken = claim_codes.remove(code_hash).expect("just found");
        Ok(self
            .tunnels
            .borrow()
            .get(&taken.tunnel_name)
            .map(|stored| stored.tunnel.clone()))
    }

    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError> {
        let mut claim_codes = self.claim_codes.borrow_mut();
        let before = claim_codes.len();
        claim_codes.retain(|_, stored| stored.expires_at > now);
        Ok(before - claim_codes.len())
    }
}

impl FakeTunnelStore {
    /// Every stored claim code, by hash.
    pub(crate) fn claim_codes(&self) -> Vec<StoredClaimCode> {
        self.claim_codes.borrow().values().cloned().collect()
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
