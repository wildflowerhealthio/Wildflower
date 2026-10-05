//! [`TunnelSet`] — the tunnels the relay serves, with their loopback ports.
//!
//! The relay serves the tunnels in `WILDFLOWER_RELAY_TUNNELS` plus the stored
//! ones; a name in both is a startup error. Everything that knows about
//! tunnels is built from one set: the rathole TOML (see [`crate::config`]),
//! the front's route table and the signature verifier's keys.
//!
//! Each tunnel has a loopback port, where rathole listens for that device
//! and the front connects. The environment's tunnels take
//! `WILDFLOWER_RELAY_TUNNEL_PORT_BASE` onwards in name order and the stored
//! ones follow, also in name order. A tunnel added later takes the port
//! after the highest one handed out so far, so within one set's lifetime no
//! port is handed out twice, even after its tunnel is removed. Ports are not
//! stored: they only join rathole to the front within one process, so a
//! restart numbers them afresh.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};

use serde::Serialize;

use crate::domain::StoredTunnel;
use crate::settings::{ControlSettings, Tunnel};

/// Where a live tunnel comes from. Serialized lowercase, as the admin API
/// lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// `WILDFLOWER_RELAY_TUNNELS`.
    Env,
    /// The [`TunnelStore`](crate::domain::TunnelStore), through the admin API.
    Store,
}

/// One tunnel the relay serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTunnel {
    pub tunnel: Tunnel,
    /// The loopback port rathole binds for it.
    pub port: u16,
    /// Who it belongs to and when it was created (Unix epoch seconds), for
    /// a stored tunnel; `None` for one from the environment.
    pub stored: Option<(String, i64)>,
}

impl LiveTunnel {
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, self.port))
    }

    #[must_use]
    pub fn source(&self) -> Source {
        if self.stored.is_some() {
            Source::Store
        } else {
            Source::Env
        }
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
    /// The environment's tunnels, then `stored`.
    ///
    /// # Errors
    ///
    /// Returns an error if a stored tunnel has the name of one in the
    /// environment, or there are not enough ports for all of them.
    pub fn new(control: &ControlSettings, stored: Vec<StoredTunnel>) -> anyhow::Result<Self> {
        let mut set = Self {
            tunnels: BTreeMap::new(),
            next_port: u32::from(control.tunnel_port_base),
        };
        for tunnel in &control.tunnels {
            set.add(tunnel.clone(), None).map_err(|error| {
                anyhow::anyhow!(
                    "{} leaves no port for tunnel {:?} ({error:?})",
                    ControlSettings::TUNNEL_PORT_BASE_VAR,
                    tunnel.name
                )
            })?;
        }
        for stored in stored {
            let name = stored.tunnel.name.clone();
            match set.add(stored.tunnel, Some((stored.email, stored.created_at))) {
                Ok(()) => {}
                Err(AddError::Taken) => anyhow::bail!(
                    "tunnel name {name:?} is both in {} and stored; remove it from one",
                    ControlSettings::TUNNELS_VAR
                ),
                Err(AddError::NoPortLeft) => anyhow::bail!(
                    "{} leaves no port for stored tunnel {name:?}",
                    ControlSettings::TUNNEL_PORT_BASE_VAR
                ),
            }
        }
        Ok(set)
    }

    /// Add `tunnel` on the next port.
    ///
    /// # Errors
    ///
    /// See [`AddError`].
    pub fn add(&mut self, tunnel: Tunnel, stored: Option<(String, i64)>) -> Result<(), AddError> {
        if self.tunnels.contains_key(&tunnel.name) {
            return Err(AddError::Taken);
        }
        let port = u16::try_from(self.next_port).map_err(|_| AddError::NoPortLeft)?;
        self.next_port += 1;
        self.tunnels.insert(
            tunnel.name.clone(),
            LiveTunnel {
                tunnel,
                port,
                stored,
            },
        );
        Ok(())
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
            .map(|live| (live.tunnel.name.clone(), live.addr()))
            .collect()
    }

    /// Each tunnel's name and token, for the signature
    /// [`Verifier`](crate::site::signature::Verifier).
    #[must_use]
    pub fn tunnels(&self) -> Vec<Tunnel> {
        self.iter().map(|live| live.tunnel.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::stored_tunnel;
    use crate::settings::Secret;
    use crate::test_support::settings;

    #[test]
    fn the_environment_takes_the_first_ports_in_name_order_then_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let control = settings(dir.path(), "carol=t3,alice=t1", 6000, None).control;
        let stored = stored_tunnel("bob");
        let set = TunnelSet::new(&control, vec![stored.clone()]).unwrap();
        let addrs: Vec<_> = set
            .addrs()
            .into_iter()
            .map(|(name, addr)| format!("{name}={addr}"))
            .collect();
        assert_eq!(
            addrs,
            [
                "alice=127.0.0.1:6000",
                "bob=127.0.0.1:6002",
                "carol=127.0.0.1:6001"
            ]
        );
        assert_eq!(set.get("bob").unwrap().source(), Source::Store);
        assert_eq!(set.get("alice").unwrap().source(), Source::Env);

        let control = settings(dir.path(), "bob=t1", 6000, None).control;
        let err = format!("{:#}", TunnelSet::new(&control, vec![stored]).unwrap_err());
        assert!(err.contains("\"bob\" is both"), "{err}");
    }

    #[test]
    fn ports_stop_at_65535() {
        let dir = tempfile::tempdir().unwrap();
        let control = settings(dir.path(), "alice=t1", 65535, None).control;
        let mut set = TunnelSet::new(&control, Vec::new()).unwrap();
        let bob = Tunnel {
            name: "bob".to_owned(),
            token: Secret::new("t2"),
        };
        assert_eq!(set.add(bob, None), Err(AddError::NoPortLeft));
        assert_eq!(set.len(), 1);
    }
}
