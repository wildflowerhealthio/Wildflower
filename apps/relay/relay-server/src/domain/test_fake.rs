//! The in-memory [`TunnelStore`] fake the
//! [`capabilities`](crate::domain::capabilities) unit tests drive, plus the
//! [`stored_tunnel`] builder they (and the `db` and registry tests) seed
//! with. Modelling the real primitive semantics — `insert_tunnel` reports a
//! name already stored as `false` (the primary key), `delete_tunnel` and
//! `replace_token` return the tunnel as it was or `None` on a miss,
//! `list_tunnels` is by name — it
//! keeps tunnels with no diesel and no database. It is the
//! [`ClaimCodeStore`] fake too, keeping codes by hash and at most one per
//! tunnel as the database's keys do, and deleting a tunnel's code with it as
//! its `ON DELETE CASCADE` does. And it is the [`ConnectionTotalsStore`]
//! fake,
//! one count per hour and outcome. The `SQLite` adapter's own coverage
//! lives in `crate::db`.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::domain::{
    ClaimCodeHash, ClaimCodeStore, ClaimCodeTarget, ConnectionTotalsStore, HourlyCount, Outcome,
    StoredClaimCode, StoredTunnel, Tunnel, TunnelError, TunnelStore,
};
use crate::settings::Secret;

#[derive(Default)]
pub(crate) struct FakeTunnelStore {
    tunnels: RefCell<BTreeMap<String, StoredTunnel>>,
    claim_codes: RefCell<BTreeMap<ClaimCodeHash, StoredClaimCode>>,
    connection_totals: RefCell<BTreeMap<(i64, Outcome), u64>>,
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
            .retain(|_, stored| !names(&stored.target, name));
        Ok(deleted)
    }

    fn replace_token(&self, tunnel: &Tunnel) -> Result<Option<StoredTunnel>, TunnelError> {
        let mut tunnels = self.tunnels.borrow_mut();
        let Some(stored) = tunnels.get_mut(&tunnel.name) else {
            return Ok(None);
        };
        let previous = stored.clone();
        stored.tunnel.token = tunnel.token.clone();
        Ok(Some(previous))
    }
}

impl ClaimCodeStore for FakeTunnelStore {
    fn insert_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError> {
        if let ClaimCodeTarget::Preset { tunnel_name } = &stored.target {
            if !self.tunnels.borrow().contains_key(tunnel_name) {
                return Err(TunnelError::infrastructure(
                    "storing the claim code failed",
                    "FOREIGN KEY constraint failed",
                ));
            }
        }
        let mut claim_codes = self.claim_codes.borrow_mut();
        if claim_codes.contains_key(&stored.code_hash) {
            return Ok(false);
        }
        if let ClaimCodeTarget::Preset { tunnel_name } = &stored.target {
            claim_codes.retain(|_, outstanding| !names(&outstanding.target, tunnel_name));
        }
        claim_codes.insert(stored.code_hash, stored.clone());
        Ok(true)
    }

    fn claim_code_target(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<ClaimCodeTarget>, TunnelError> {
        Ok(self
            .claim_codes
            .borrow()
            .get(code_hash)
            .filter(|stored| stored.expires_at > now)
            .map(|stored| stored.target.clone()))
    }

    fn take_preset_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError> {
        let Some(ClaimCodeTarget::Preset { tunnel_name }) =
            self.claim_code_target(code_hash, now)?
        else {
            return Ok(None);
        };
        self.claim_codes.borrow_mut().remove(code_hash);
        Ok(self
            .tunnels
            .borrow()
            .get(&tunnel_name)
            .map(|stored| stored.tunnel.clone()))
    }

    fn take_open_claim_code_for_tunnel(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
        tunnel: &StoredTunnel,
    ) -> Result<Option<StoredClaimCode>, TunnelError> {
        if self.claim_code_target(code_hash, now)? != Some(ClaimCodeTarget::Open) {
            return Ok(None);
        }
        if !self.insert_tunnel(tunnel)? {
            return Err(TunnelError::infrastructure(
                "redeeming the claim code failed",
                "UNIQUE constraint failed: tunnels.name",
            ));
        }
        Ok(self.claim_codes.borrow_mut().remove(code_hash))
    }

    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError> {
        let mut claim_codes = self.claim_codes.borrow_mut();
        let before = claim_codes.len();
        claim_codes.retain(|_, stored| stored.expires_at > now);
        Ok(before - claim_codes.len())
    }
}

/// Whether `target` is a preset code for the tunnel named `tunnel_name`.
fn names(target: &ClaimCodeTarget, tunnel_name: &str) -> bool {
    matches!(target, ClaimCodeTarget::Preset { tunnel_name: named } if named == tunnel_name)
}

impl ConnectionTotalsStore for FakeTunnelStore {
    fn add_connection_totals(&self, counts: &[HourlyCount]) -> Result<(), TunnelError> {
        let mut totals = self.connection_totals.borrow_mut();
        for counted in counts {
            *totals.entry((counted.hour, counted.outcome)).or_default() += counted.count;
        }
        Ok(())
    }

    fn delete_connection_totals_before(&self, hour: i64) -> Result<usize, TunnelError> {
        let mut totals = self.connection_totals.borrow_mut();
        let before = totals.len();
        totals.retain(|(counted_hour, _), _| *counted_hour >= hour);
        Ok(before - totals.len())
    }

    fn connection_totals_since(&self, hour: i64) -> Result<Vec<HourlyCount>, TunnelError> {
        Ok(self
            .connection_totals
            .borrow()
            .range((hour, Outcome::ALL[0])..)
            .map(|(&(hour, outcome), &count)| HourlyCount {
                hour,
                outcome,
                count,
            })
            .collect())
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
