//! [`TunnelSet`] — the tunnels the relay serves.
//!
//! The relay serves the stored tunnels, the ones created through the admin
//! API. Everything that knows about tunnels is built from one set: rathole's
//! services (see [`crate::config`]), the front's route table and the
//! signature verifier's keys.

use std::collections::BTreeMap;

use crate::domain::{StoredTunnel, Tunnel};

/// The tunnels the relay serves, by name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelSet {
    tunnels: BTreeMap<String, StoredTunnel>,
}

impl TunnelSet {
    /// The set of `stored`.
    ///
    /// # Errors
    ///
    /// Returns an error if two stored tunnels share a name.
    pub fn new(stored: Vec<StoredTunnel>) -> anyhow::Result<Self> {
        let mut set = Self::default();
        for stored in stored {
            let name = stored.tunnel.name.clone();
            anyhow::ensure!(set.add(stored), "tunnel name {name:?} is stored twice");
        }
        Ok(set)
    }

    /// Add `stored`. `false`, leaving the set as it is, if a tunnel of that
    /// name is already in it.
    pub fn add(&mut self, stored: StoredTunnel) -> bool {
        if self.tunnels.contains_key(&stored.tunnel.name) {
            return false;
        }
        self.tunnels.insert(stored.tunnel.name.clone(), stored);
        true
    }

    /// Remove the tunnel named `name`, if there is one.
    pub fn remove(&mut self, name: &str) -> Option<StoredTunnel> {
        self.tunnels.remove(name)
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&StoredTunnel> {
        self.tunnels.get(name)
    }

    /// Every tunnel, by name.
    pub fn iter(&self) -> impl Iterator<Item = &StoredTunnel> {
        self.tunnels.values()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tunnels.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tunnels.is_empty()
    }

    /// Each tunnel's name, for a [`RouteTable`](crate::route::RouteTable).
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.tunnels.keys().cloned().collect()
    }

    /// Each tunnel's name and token, for rathole's services and the
    /// signature [`Verifier`](crate::site::signature::Verifier).
    #[must_use]
    pub fn tunnels(&self) -> Vec<Tunnel> {
        self.iter().map(|stored| stored.tunnel.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::stored_tunnel;

    #[test]
    fn stored_tunnels_are_kept_by_name_and_names_are_unique() {
        let stored = ["carol", "alice", "bob"].map(stored_tunnel).to_vec();
        let mut set = TunnelSet::new(stored).unwrap();
        assert_eq!(set.names(), ["alice", "bob", "carol"]);
        assert!(!set.add(stored_tunnel("bob")));
        assert_eq!(set.len(), 3);

        let twice = vec![stored_tunnel("bob"), stored_tunnel("bob")];
        let err = format!("{:#}", TunnelSet::new(twice).unwrap_err());
        assert!(err.contains("\"bob\" is stored twice"), "{err}");
    }
}
