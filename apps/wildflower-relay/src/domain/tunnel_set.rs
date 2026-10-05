//! [`TunnelSet`] — the tunnels the relay serves, with their loopback ports.
//!
//! The relay serves the stored tunnels, the ones created through the admin
//! API. Everything that knows about tunnels is built from one set: the
//! rathole TOML (see [`crate::config`]), the front's route table and the
//! signature verifier's keys.
//!
//! Each tunnel has a loopback port, where rathole listens for that device
//! and the front connects. At startup the stored tunnels take
//! `WILDFLOWER_RELAY_TUNNEL_PORT_BASE` onwards in name order. A tunnel added
//! later takes the port after the highest one handed out so far, so within
//! one set's lifetime no port is handed out twice, even after its tunnel is
//! removed. Ports are not stored: they only join rathole to the front within
//! one process, so a restart numbers them afresh.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};

use crate::domain::{StoredTunnel, Tunnel};
use crate::settings::ControlSettings;

/// One tunnel the relay serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTunnel {
    pub stored: StoredTunnel,
    /// The loopback port rathole binds for it.
    pub port: u16,
}

impl LiveTunnel {
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, self.port))
    }
}

/// Why a tunnel could not join a [`TunnelSet`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddError {
    /// A tunnel of that name is already live.
    Taken,
    /// Every port up to 65535 has been handed out.
    NoPortLeft,
}

/// The tunnels the relay serves, by name, with their ports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelSet {
    tunnels: BTreeMap<String, LiveTunnel>,
    /// The port the next added tunnel gets. It only counts up, so a port
    /// stays unused after its tunnel is removed. Past `u16::MAX` none is
    /// left.
    next_port: u32,
}

impl TunnelSet {
    /// `stored`, from `port_base` onwards in name order.
    ///
    /// # Errors
    ///
    /// Returns an error if two stored tunnels share a name, or there are
    /// not enough ports for all of them.
    pub fn new(port_base: u16, mut stored: Vec<StoredTunnel>) -> anyhow::Result<Self> {
        stored.sort_by(|a, b| a.tunnel.name.cmp(&b.tunnel.name));
        let mut set = Self {
            tunnels: BTreeMap::new(),
            next_port: u32::from(port_base),
        };
        for stored in stored {
            let name = stored.tunnel.name.clone();
            match set.add(stored) {
                Ok(()) => {}
                Err(AddError::Taken) => anyhow::bail!("tunnel name {name:?} is stored twice"),
                Err(AddError::NoPortLeft) => anyhow::bail!(
                    "{} = {port_base} leaves no port for stored tunnel {name:?}",
                    ControlSettings::TUNNEL_PORT_BASE_VAR
                ),
            }
        }
        Ok(set)
    }

    /// Add `stored` on the next port.
    ///
    /// # Errors
    ///
    /// See [`AddError`].
    pub fn add(&mut self, stored: StoredTunnel) -> Result<(), AddError> {
        if self.tunnels.contains_key(&stored.tunnel.name) {
            return Err(AddError::Taken);
        }
        let port = u16::try_from(self.next_port).map_err(|_| AddError::NoPortLeft)?;
        self.next_port += 1;
        self.tunnels
            .insert(stored.tunnel.name.clone(), LiveTunnel { stored, port });
        Ok(())
    }

    /// Whether [`Self::add`] has a port left to hand out.
    #[must_use]
    pub fn has_free_port(&self) -> bool {
        u16::try_from(self.next_port).is_ok()
    }

    /// Remove the tunnel named `name`, if there is one. Its port is not
    /// handed out again.
    pub fn remove(&mut self, name: &str) -> Option<LiveTunnel> {
        self.tunnels.remove(name)
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&LiveTunnel> {
        self.tunnels.get(name)
    }

    /// Every tunnel, by name.
    pub fn iter(&self) -> impl Iterator<Item = &LiveTunnel> {
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

    /// Each tunnel's name and loopback address, for a
    /// [`RouteTable`](crate::route::RouteTable).
    #[must_use]
    pub fn addrs(&self) -> Vec<(String, SocketAddr)> {
        self.iter()
            .map(|live| (live.stored.tunnel.name.clone(), live.addr()))
            .collect()
    }

    /// Each tunnel's name and token, for the signature
    /// [`Verifier`](crate::site::signature::Verifier).
    #[must_use]
    pub fn tunnels(&self) -> Vec<Tunnel> {
        self.iter().map(|live| live.stored.tunnel.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::stored_tunnel;

    #[test]
    fn stored_tunnels_take_the_ports_from_the_base_in_name_order() {
        let stored = ["carol", "alice", "bob"].map(stored_tunnel).to_vec();
        let set = TunnelSet::new(6000, stored).unwrap();
        let addrs: Vec<_> = set
            .addrs()
            .into_iter()
            .map(|(name, addr)| format!("{name}={addr}"))
            .collect();
        assert_eq!(
            addrs,
            [
                "alice=127.0.0.1:6000",
                "bob=127.0.0.1:6001",
                "carol=127.0.0.1:6002"
            ]
        );

        let twice = vec![stored_tunnel("bob"), stored_tunnel("bob")];
        let err = format!("{:#}", TunnelSet::new(6000, twice).unwrap_err());
        assert!(err.contains("\"bob\" is stored twice"), "{err}");
    }

    #[test]
    fn ports_stop_at_65535() {
        let mut set = TunnelSet::new(65535, vec![stored_tunnel("alice")]).unwrap();
        assert!(!set.has_free_port());
        assert_eq!(set.add(stored_tunnel("bob")), Err(AddError::NoPortLeft));
        assert_eq!(set.len(), 1);

        let err = TunnelSet::new(65535, vec![stored_tunnel("a"), stored_tunnel("b")]).unwrap_err();
        let err = format!("{err:#}");
        assert!(
            err.contains(ControlSettings::TUNNEL_PORT_BASE_VAR) && err.contains("\"b\""),
            "{err}"
        );
    }
}
