//! The [`TunnelRegistry`] — the admin API's router state: the
//! [`SqliteTunnelStore`] the capabilities are lifted from, and what serves
//! the stored tunnels while the relay runs, changed together with the store.
//!
//! At startup it opens the store and builds rathole's config (see
//! [`crate::config`]), the front's route table and the [`Verifier`]'s keys
//! from the stored tunnels. A capability binding changes it through
//! `TunnelRegistry::change`: the capability decides the change and writes
//! the store, then the registry sends rathole the service the change adds
//! or deletes ([`ServerServiceChange`]), and adds or removes the tunnel's
//! route ([`Router::insert`], [`Router::remove`]) and key
//! ([`Verifier::insert`], [`Verifier::remove`]). If rathole has stopped
//! taking changes the capability's undo puts the store back, so on an error
//! nothing has changed. A created tunnel's device can connect and sign
//! requests at once. A deleted one stops routing and signing at once, and
//! its tunnel drops as rathole takes the change.

use std::sync::Arc;

use anyhow::Context;
use rathole::{ConfigChange, ServerServiceChange};
use tokio::sync::{mpsc, Mutex};

use super::on_blocking;
use crate::config;
use crate::db::SqliteTunnelStore;
use crate::domain::{StoredTunnel, Tunnel, TunnelError, TunnelStore};
use crate::route::{RouteTable, Router};
use crate::settings::{FrontSettings, RelaySettings};
use crate::site::signature::Verifier;

/// How many changes can wait for rathole. Changes apply one at a time, and
/// rathole takes each once its accept loop is free (it may be finishing a
/// control channel's handshake, for up to five seconds), so a few are
/// plenty; a change that finds the queue full waits for room.
const RATHOLE_CHANGES: usize = 16;

/// What the relay's rathole server runs on (see
/// [`Tunnels::serve`](crate::Tunnels::serve)): its config for the tunnels
/// stored at startup, then each change to them, in order.
#[derive(Debug)]
pub struct RatholeFeed {
    pub config: rathole::Config,
    pub changes: mpsc::Receiver<ConfigChange>,
}

/// What a change does to the tunnel it returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    /// The tunnel was stored, and is served from now on.
    Created,
    /// The tunnel was deleted, and is no longer served.
    Deleted,
}

/// The tunnel store and what serves the stored tunnels, changed together.
pub struct TunnelRegistry {
    /// The store the capabilities are lifted from.
    pub(crate) store: SqliteTunnelStore,
    pub(crate) front: FrontSettings,
    /// Where each change goes to rathole.
    rathole: mpsc::Sender<ConfigChange>,
    router: Arc<Router>,
    verifier: Arc<Verifier>,
    /// Held across a whole change, so changes apply one at a time.
    changing: Mutex<()>,
}

impl std::fmt::Debug for TunnelRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelRegistry").finish_non_exhaustive()
    }
}

impl TunnelRegistry {
    /// Open the store in `settings.state_dir`, which must exist, and build
    /// the [`RatholeFeed`] that serves the tunnels stored in it.
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be opened or read, or rathole's
    /// config cannot be built (see [`config::build`]).
    pub async fn open(settings: &RelaySettings) -> anyhow::Result<(Self, RatholeFeed)> {
        let store_path = settings.state_dir.join(SqliteTunnelStore::FILE_NAME);
        let (store, stored) = tokio::task::spawn_blocking(move || {
            let store = SqliteTunnelStore::open(&store_path)?;
            let stored = store
                .list_tunnels()
                .with_context(|| format!("reading {}", store_path.display()))?;
            anyhow::Ok((store, stored))
        })
        .await
        .context("opening the tunnel store panicked")??;
        let tunnels: Vec<Tunnel> = stored.into_iter().map(|stored| stored.tunnel).collect();
        let config = config::build(&settings.control, &tunnels)?;
        let (rathole, changes) = mpsc::channel(RATHOLE_CHANGES);
        let router = Router::new(
            &settings.front.domain,
            settings.front.local_hostnames(),
            RouteTable::from_names(tunnels.iter().map(|tunnel| tunnel.name.clone())),
        );
        let verifier = Verifier::new(&tunnels, settings.admin_key.clone());
        let registry = Self {
            store,
            front: settings.front.clone(),
            rathole,
            router: Arc::new(router),
            verifier: Arc::new(verifier),
            changing: Mutex::new(()),
        };
        Ok((registry, RatholeFeed { config, changes }))
    }

    /// The front's router, whose table follows the stored tunnels.
    #[must_use]
    pub fn router(&self) -> Arc<Router> {
        Arc::clone(&self.router)
    }

    /// The site's verifier, whose keys follow the stored tunnels.
    #[must_use]
    pub fn verifier(&self) -> Arc<Verifier> {
        Arc::clone(&self.verifier)
    }

    /// The hostname the admin API is served on.
    #[must_use]
    pub fn admin_hostname(&self) -> String {
        self.front.admin_hostname()
    }

    /// Change the tunnels, one change at a time: run `decide` on a blocking
    /// thread, where it writes the store and returns the tunnel it created
    /// or deleted (as `change` says); serve that change; and if serving
    /// fails, run `undo` on a blocking thread to put the store back (logging
    /// `undo_failed` if that fails too).
    ///
    /// # Errors
    ///
    /// Whatever `decide` refuses or fails with, or
    /// [`TunnelError::Infrastructure`] if serving fails. On an error what is
    /// served has not changed.
    pub(crate) async fn change(
        &self,
        change: Change,
        decide: impl FnOnce() -> Result<StoredTunnel, TunnelError> + Send + 'static,
        undo: impl FnOnce(&StoredTunnel) -> Result<(), TunnelError> + Send + 'static,
        undo_failed: &'static str,
    ) -> Result<StoredTunnel, TunnelError> {
        let _changing = self.changing.lock().await;
        let changed = on_blocking(decide).await?;
        if let Err(error) = self.serve(change, &changed.tunnel).await {
            let name = changed.tunnel.name.clone();
            if let Err(undo_error) = on_blocking(move || undo(&changed)).await {
                tracing::error!(tunnel = %name, "{undo_failed}: {undo_error}");
            }
            return Err(error);
        }
        Ok(changed)
    }

    /// Send rathole the service `change` adds or deletes for `tunnel`, then
    /// add or remove its route and key.
    async fn serve(&self, change: Change, tunnel: &Tunnel) -> Result<(), TunnelError> {
        let service_change = match change {
            Change::Created => ServerServiceChange::Add(config::service(tunnel)),
            Change::Deleted => ServerServiceChange::Delete(tunnel.name.clone()),
        };
        self.rathole
            .send(ConfigChange::ServerChange(service_change))
            .await
            .map_err(|e| TunnelError::infrastructure("rathole has stopped taking changes", e))?;
        match change {
            Change::Created => {
                self.router.insert(tunnel.name.clone());
                self.verifier.insert(tunnel);
            }
            Change::Deleted => {
                self.router.remove(&tunnel.name);
                self.verifier.remove(&tunnel.name);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::broadcast;

    use super::*;
    use crate::domain::test_fake::stored_tunnel;
    use crate::live_bindings::{LiveTunnelsCreator, LiveTunnelsDeleter};
    use crate::route::Destination;
    use crate::test_support::{admin, device, open_registry, registry, settings, until_connected};
    use crate::tunnels::{TunnelDown, Tunnels};

    /// At startup the stored tunnels are served: as rathole's services, in
    /// the routes and in the verifier's keys.
    #[tokio::test]
    async fn opening_serves_the_stored_tunnels() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SqliteTunnelStore::open(&dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
        for name in ["carol", "alice"] {
            store.insert_tunnel(&stored_tunnel(name)).unwrap();
        }
        drop(store);

        let (registry, rathole) = open_registry(&settings(dir.path(), None)).await;
        let services = rathole.config.server.expect("[server]").services;
        assert_eq!(services.len(), 2);
        assert_eq!(services["carol"].token.as_deref(), Some("carol-token"));
        for host in ["alice.relay.example.com", "carol.relay.example.com"] {
            assert!(registry.router().resolve(host).is_some(), "{host}");
        }
    }

    /// Once rathole has stopped, a change is undone: nothing is stored,
    /// routed or verified.
    #[tokio::test]
    async fn a_change_rathole_cannot_take_is_undone() {
        let (registry, fixture) = registry(None).await;
        drop(fixture.rathole);
        let creator: LiveTunnelsCreator = admin(&registry);
        let refused = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap_err();
        assert!(matches!(refused, TunnelError::Infrastructure { .. }));
        assert!(registry.store.list_tunnels().unwrap().is_empty());
        assert!(registry.router().resolve("bob.relay.example.com").is_none());
    }

    /// With the real rathole server and a rathole client as the device: a
    /// created tunnel is down until its device connects and then takes
    /// visitors, and a deleted one stops routing at once and drops.
    #[tokio::test]
    async fn a_created_tunnel_takes_visitors_once_its_device_connects_until_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = settings(dir.path(), None);
        let control_port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        settings.control.control_addr = ([127, 0, 0, 1], control_port).into();
        let (registry, rathole) = open_registry(&settings).await;
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let tunnels = Tunnels::default();
        tokio::spawn(tunnels.clone().serve(
            rathole.config,
            rathole.changes,
            shutdown_rx.resubscribe(),
        ));

        let creator: LiveTunnelsCreator = admin(&registry);
        let created = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        let router = registry.router();
        assert!(matches!(
            router.resolve("bob.relay.example.com"),
            Some(Destination::Tunnel(_))
        ));
        let offline = tunnels.connect("bob", tokio::io::duplex(64).1).await;
        assert_eq!(offline, Err(TunnelDown));

        let token = created.tunnel.token.expose();
        let mut device_visitors = device(&settings, "bob", token, shutdown_rx).await;
        until_connected(&tunnels, "bob", &mut device_visitors).await;
        let (mut visitor, stream) = tokio::io::duplex(64);
        tunnels.connect("bob", stream).await.unwrap();
        let mut at_device = tokio::time::timeout(Duration::from_secs(5), device_visitors.recv())
            .await
            .unwrap()
            .unwrap();
        visitor.write_all(b"hello").await.unwrap();
        let mut hello = [0; 5];
        at_device.read_exact(&mut hello).await.unwrap();
        assert_eq!(&hello, b"hello");

        let deleter: LiveTunnelsDeleter = admin(&registry);
        deleter.delete("bob".to_owned()).await.unwrap();
        assert!(router.resolve("bob.relay.example.com").is_none());
        let dropped = async {
            while tunnels
                .connect("bob", tokio::io::duplex(64).1)
                .await
                .is_ok()
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), dropped)
            .await
            .expect("the deleted tunnel should drop");
        let _ = shutdown_tx.send(true);
    }
}
