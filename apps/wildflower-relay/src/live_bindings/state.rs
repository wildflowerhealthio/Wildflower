//! The [`TunnelRegistry`] — the admin API's router state: the live
//! [`TunnelSet`] and everything built from it, changed together while the
//! relay runs, and the [`SqliteTunnelStore`] the capabilities are lifted
//! from.
//!
//! At startup it opens the store, builds the live set from the stored
//! tunnels, and builds rathole's config (see [`crate::config`]), the front's
//! route table and the [`Verifier`]'s keys from it. A capability binding
//! changes it through `TunnelRegistry::change`: the capability decides the
//! change and writes the store, then the registry sends rathole the service
//! it adds or deletes ([`ServerServiceChange`]), and swaps the routes
//! ([`Router::replace`]) and keys ([`Verifier::replace`]). If rathole has
//! stopped taking changes the capability's undo puts the store back, so on
//! an error nothing has changed. A created tunnel's device can connect and
//! sign requests at once. A deleted one stops routing and signing at once,
//! and its tunnel drops as rathole takes the change.

use std::sync::Arc;

use anyhow::Context;
use rathole::{ConfigChange, ServerServiceChange};
use tokio::sync::{mpsc, Mutex};

use super::on_blocking;
use crate::config;
use crate::db::SqliteTunnelStore;
use crate::domain::{StoredTunnel, TunnelError, TunnelSet, TunnelStore};
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

/// The live [`TunnelSet`] and everything built from it, changed together.
pub struct TunnelRegistry {
    /// The store the capabilities are lifted from.
    pub(crate) store: SqliteTunnelStore,
    pub(crate) front: FrontSettings,
    /// Where each change goes to rathole.
    rathole: mpsc::Sender<ConfigChange>,
    router: Arc<Router>,
    verifier: Arc<Verifier>,
    /// Held across a whole change, so changes apply one at a time.
    set: Mutex<TunnelSet>,
}

impl std::fmt::Debug for TunnelRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelRegistry").finish_non_exhaustive()
    }
}

impl TunnelRegistry {
    /// Open the store in `settings.state_dir`, which must exist, build the
    /// live set from it, and the [`RatholeFeed`] that serves it.
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be opened or read, the live set
    /// cannot be built (see [`TunnelSet::new`]) or rathole's config cannot
    /// be built (see [`config::build`]).
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
        let set = TunnelSet::new(stored)?;
        let config = config::build(&settings.control, &set)?;
        let (rathole, changes) = mpsc::channel(RATHOLE_CHANGES);
        let router = Router::new(
            &settings.front.domain,
            settings.front.local_hostnames(),
            RouteTable::from_names(set.names()),
        );
        let verifier = Verifier::new(&set.tunnels(), settings.admin_key.clone());
        let registry = Self {
            store,
            front: settings.front.clone(),
            rathole,
            router: Arc::new(router),
            verifier: Arc::new(verifier),
            set: Mutex::new(set),
        };
        Ok((registry, RatholeFeed { config, changes }))
    }

    /// The front's router, whose table follows the live set.
    #[must_use]
    pub fn router(&self) -> Arc<Router> {
        Arc::clone(&self.router)
    }

    /// The site's verifier, whose keys follow the live set.
    #[must_use]
    pub fn verifier(&self) -> Arc<Verifier> {
        Arc::clone(&self.verifier)
    }

    /// The hostname the admin API is served on.
    #[must_use]
    pub fn admin_hostname(&self) -> String {
        self.front.admin_hostname()
    }

    /// Every live tunnel, by name.
    pub async fn list(&self) -> Vec<StoredTunnel> {
        self.set.lock().await.iter().cloned().collect()
    }

    /// Change the live set, one change at a time: run `decide` against it on
    /// a blocking thread, where it writes the store and returns the tunnel
    /// it changed and the set to serve next; serve that set; and if serving
    /// fails, run `undo` on a blocking thread to put the store back (logging
    /// `undo_failed` if that fails too).
    ///
    /// # Errors
    ///
    /// Whatever `decide` refuses or fails with, or
    /// [`TunnelError::Infrastructure`] if serving fails. On an error the
    /// live set has not changed.
    pub(crate) async fn change(
        &self,
        decide: impl FnOnce(&TunnelSet) -> Result<(StoredTunnel, TunnelSet), TunnelError>
            + Send
            + 'static,
        undo: impl FnOnce(&StoredTunnel) -> Result<(), TunnelError> + Send + 'static,
        undo_failed: &'static str,
    ) -> Result<StoredTunnel, TunnelError> {
        let mut set = self.set.lock().await;
        let live = set.clone();
        let (changed, next) = on_blocking(move || decide(&live)).await?;
        if let Err(error) = self.apply(&changed, &next).await {
            let name = changed.tunnel.name.clone();
            if let Err(undo_error) = on_blocking(move || undo(&changed)).await {
                tracing::error!(tunnel = %name, "{undo_failed}: {undo_error}");
            }
            return Err(error);
        }
        *set = next;
        Ok(changed)
    }

    /// Send rathole the service `changed` adds to or deletes from the live
    /// set to make `next`, then swap the routes and keys to `next`.
    async fn apply(&self, changed: &StoredTunnel, next: &TunnelSet) -> Result<(), TunnelError> {
        let tunnel = &changed.tunnel;
        let change = if next.get(&tunnel.name).is_some() {
            ServerServiceChange::Add(config::service(tunnel))
        } else {
            ServerServiceChange::Delete(tunnel.name.clone())
        };
        self.rathole
            .send(ConfigChange::ServerChange(change))
            .await
            .map_err(|e| TunnelError::infrastructure("rathole has stopped taking changes", e))?;
        self.router.replace(RouteTable::from_names(next.names()));
        self.verifier.replace(&next.tunnels());
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

    fn names(tunnels: &[StoredTunnel]) -> Vec<&str> {
        tunnels.iter().map(|t| t.tunnel.name.as_str()).collect()
    }

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
        assert_eq!(names(&registry.list().await), ["alice", "carol"]);
        let services = rathole.config.server.expect("[server]").services;
        assert_eq!(services.len(), 2);
        assert_eq!(services["carol"].token.as_deref(), Some("carol-token"));
        assert!(registry
            .router()
            .resolve("alice.relay.example.com")
            .is_some());
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
        assert!(registry.list().await.is_empty());
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
