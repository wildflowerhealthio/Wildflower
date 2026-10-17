//! The [`TunnelRegistry`] — the admin API's router state: the
//! [`SqliteTunnelStore`] the capabilities are lifted from, and what serves
//! the stored tunnels while the relay runs, changed together with the store.
//!
//! At startup it opens the store and builds rathole's config (see
//! [`crate::config`]) and the [`ServedTunnels`] the front's [`Router`] and
//! the site's [`Verifier`] share from the stored tunnels. A capability
//! binding changes it through `TunnelRegistry::change`: the capability
//! writes the store, then the registry sends rathole the service the change
//! adds or deletes ([`ServerServiceChange`]) and inserts or removes the
//! tunnel in the [`ServedTunnels`]. If rathole has stopped taking changes
//! the capability's undo puts the store back, so on an error nothing has
//! changed. A created tunnel's device can connect and sign requests at
//! once. A deleted one stops routing and signing at once, and its tunnel
//! drops as rathole takes the change. A reissued token signs at once, the
//! old one stops signing at once, and a device connected with the old one
//! drops as rathole takes the change.
//!
//! Claim codes live in the same store and change nothing that is served.
//! Issuing one runs through `TunnelRegistry::while_unchanged`, between
//! tunnel changes, so the tunnel it is for cannot be deleted under it.
//!
//! The registry also holds the [`ConnectionOutcomes`] the front records
//! into: a deleted tunnel's last outcome is dropped once it stops being
//! served, so a tunnel created later under the name starts with none, and a
//! reissued token keeps it. The hourly counts reach the store's totals
//! through `TunnelRegistry::flush_connection_totals` (in
//! `connection_totals_flush`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use rathole::{ConfigChange, ServerServiceChange};
use tokio::sync::{mpsc, Mutex};

use super::on_blocking;
use crate::config;
use crate::db::SqliteTunnelStore;
use crate::domain::{ReissuedTunnel, StoredTunnel, Tunnel, TunnelError, TunnelStore};
use crate::logging::IDENTIFYING;
use crate::outcomes::ConnectionOutcomes;
use crate::route::Router;
use crate::served::ServedTunnels;
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
    pub initial_config: rathole::Config,
    pub changes: mpsc::Receiver<ConfigChange>,
}

/// What a change does to the tunnel it returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    /// The tunnel was stored, and is served from now on.
    Created,
    /// The tunnel was deleted, and is no longer served.
    Deleted,
    /// The tunnel's token was replaced, and only the new one is served from
    /// now on.
    TokenReissued,
}

/// What a change's store write returns: the tunnel it serves, as it is now
/// stored (or, deleted, as it was).
pub(crate) trait ChangedTunnel: Send + 'static {
    fn tunnel(&self) -> &Tunnel;
}

impl ChangedTunnel for StoredTunnel {
    fn tunnel(&self) -> &Tunnel {
        &self.tunnel
    }
}

impl ChangedTunnel for ReissuedTunnel {
    fn tunnel(&self) -> &Tunnel {
        &self.stored.tunnel
    }
}

/// The tunnel store and what serves the stored tunnels, changed together.
pub struct TunnelRegistry {
    /// The store the capabilities are lifted from.
    pub(crate) store: SqliteTunnelStore,
    pub(crate) front: FrontSettings,
    /// How long an issued claim code redeems for.
    pub(crate) claim_code_ttl: Duration,
    /// Where each change goes to rathole.
    rathole: mpsc::Sender<ConfigChange>,
    /// Shared by `router` and `verifier`.
    tunnels: Arc<ServedTunnels>,
    router: Arc<Router>,
    verifier: Arc<Verifier>,
    /// What the front records about each connection; shares `tunnels`.
    pub(crate) outcomes: Arc<ConnectionOutcomes>,
    /// Held across a whole change, so changes apply one at a time.
    changing: Mutex<()>,
    /// Held across a flush of the hourly counts and across a read of the
    /// totals, so a read never sees a count both pending and stored, or
    /// neither.
    pub(crate) totals_flush: Mutex<()>,
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
        let initial_config = config::build(&settings.control, &tunnels)?;
        let (rathole, changes) = mpsc::channel(RATHOLE_CHANGES);
        let served = Arc::new(ServedTunnels::new(&tunnels));
        let router = Router::new(
            &settings.front.domain,
            settings.front.local_hostnames(),
            Arc::clone(&served),
        );
        let verifier = Verifier::new(Arc::clone(&served), settings.admin_key.clone());
        let outcomes = Arc::new(ConnectionOutcomes::new(Arc::clone(&served)));
        let registry = Self {
            store,
            front: settings.front.clone(),
            claim_code_ttl: settings.claim_code_ttl,
            rathole,
            tunnels: served,
            router: Arc::new(router),
            verifier: Arc::new(verifier),
            outcomes,
            changing: Mutex::new(()),
            totals_flush: Mutex::new(()),
        };
        let feed = RatholeFeed {
            initial_config,
            changes,
        };
        Ok((registry, feed))
    }

    /// The front's router, which routes the stored tunnels.
    #[must_use]
    pub fn router(&self) -> Arc<Router> {
        Arc::clone(&self.router)
    }

    /// The site's verifier, for which the stored tunnels sign.
    #[must_use]
    pub fn verifier(&self) -> Arc<Verifier> {
        Arc::clone(&self.verifier)
    }

    /// What the front records about each connection, which the admin API
    /// reads.
    #[must_use]
    pub fn outcomes(&self) -> Arc<ConnectionOutcomes> {
        Arc::clone(&self.outcomes)
    }

    /// The hostname the admin API is served on.
    #[must_use]
    pub fn admin_hostname(&self) -> String {
        self.front.admin_hostname()
    }

    /// Create or delete a tunnel, or reissue its token (as `change` says),
    /// in the store and in what serves it. The create, delete and reissue
    /// bindings all go through here; they differ only in the store write, so
    /// they pass it in:
    ///
    /// 1. `write_store` creates, deletes or rewrites the tunnel in the store
    ///    and returns it, or refuses (a taken name, an unknown tunnel). It
    ///    runs on a blocking thread, as SQLite blocks.
    /// 2. The registry serves the change: rathole adds, deletes or replaces
    ///    the tunnel's service, then the tunnel is inserted into, removed
    ///    from or replaced in the [`ServedTunnels`].
    /// 3. If rathole has stopped taking changes, `undo_write` puts the store
    ///    back, so the store never holds a tunnel that is not served or
    ///    lacks one that is. Should that fail too, `undo_failed` is logged
    ///    with the error, as the two now disagree until a restart.
    ///
    /// Changes run one at a time, so two cannot interleave between the
    /// store and rathole. Each runs on its own task, so a caller that stops
    /// waiting (a client that hangs up mid-request) cannot stop it between
    /// steps 1 and 2.
    ///
    /// # Errors
    ///
    /// Whatever `write_store` refuses or fails with, or
    /// [`TunnelError::Infrastructure`] if serving fails. On an error nothing
    /// has changed.
    pub(crate) async fn change<W: ChangedTunnel>(
        self: &Arc<Self>,
        change: Change,
        write_store: impl FnOnce() -> Result<W, TunnelError> + Send + 'static,
        undo_write: impl FnOnce(&W) -> Result<(), TunnelError> + Send + 'static,
        undo_failed: &'static str,
    ) -> Result<W, TunnelError> {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            let _changing = registry.changing.lock().await;
            let changed = on_blocking(write_store).await?;
            if let Err(error) = registry.serve(change, changed.tunnel()).await {
                let name = changed.tunnel().name.clone();
                if let Err(undo_error) = on_blocking(move || undo_write(&changed)).await {
                    tracing::error!(
                        target: IDENTIFYING,
                        tunnel = %name,
                        "{undo_failed}: {undo_error}"
                    );
                }
                return Err(error);
            }
            Ok(changed)
        })
        .await
        .map_err(|e| TunnelError::infrastructure("a tunnel change task panicked", e))?
    }

    /// Run `op` on a blocking thread while no tunnel change runs, so a
    /// tunnel it finds stored stays stored until it returns. Like a change,
    /// it runs on its own task, so a caller that stops waiting cannot cut it
    /// short.
    ///
    /// # Errors
    ///
    /// Whatever `op` fails with, or [`TunnelError::Infrastructure`] if it
    /// panics.
    pub(crate) async fn while_unchanged<T: Send + 'static>(
        self: &Arc<Self>,
        op: impl FnOnce() -> Result<T, TunnelError> + Send + 'static,
    ) -> Result<T, TunnelError> {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            let _changing = registry.changing.lock().await;
            on_blocking(op).await
        })
        .await
        .map_err(|e| TunnelError::infrastructure("a tunnel store task panicked", e))?
    }

    /// Send rathole the service `change` adds, deletes or replaces for
    /// `tunnel`, then insert, remove or replace it in the [`ServedTunnels`].
    ///
    /// A reissued token is sent as the service added again: rathole replaces
    /// the service's token and drops its control channel, so a device
    /// connected with the old token is cut off at once, and can connect
    /// again only with the new one.
    async fn serve(&self, change: Change, tunnel: &Tunnel) -> Result<(), TunnelError> {
        let service_change = match change {
            Change::Created | Change::TokenReissued => {
                ServerServiceChange::Add(config::service(tunnel))
            }
            Change::Deleted => ServerServiceChange::Delete(tunnel.name.clone()),
        };
        self.rathole
            .send(ConfigChange::ServerChange(service_change))
            .await
            .map_err(|e| TunnelError::infrastructure("rathole has stopped taking changes", e))?;
        match change {
            Change::Created => self.tunnels.insert(tunnel),
            Change::Deleted => {
                self.tunnels.remove(&tunnel.name);
                // After the removal, so no request still being verified with
                // the old token can record a nonce for it, and no connection
                // still being routed to it can record an outcome.
                self.verifier.forget(&tunnel.name);
                self.outcomes.forget(&tunnel.name);
            }
            Change::TokenReissued => {
                self.tunnels.insert(tunnel);
                // The nonces were recorded under the old token, which no
                // longer verifies.
                self.verifier.forget(&tunnel.name);
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
    use wildflowerhealthio_kitchen_sink::loopback_port::free_loopback_port;

    use super::*;
    use crate::domain::test_fake::stored_tunnel;
    use crate::domain::TunnelOutcome;
    use crate::live_bindings::{LiveTunnelTokensReissuer, LiveTunnelsCreator, LiveTunnelsDeleter};
    use crate::route::Destination;
    use crate::test_support::{admin, device, open_registry, registry, settings, until_connected};
    use crate::tunnels::{TunnelDown, Tunnels};

    /// At startup the stored tunnels are served: as rathole's services, and
    /// routed and signing through the served tunnels.
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
        let services = rathole.initial_config.server.expect("[server]").services;
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

    /// A reissued token keeps the tunnel's last outcome; a delete drops it,
    /// so the name created again starts with none.
    #[tokio::test]
    async fn a_tunnels_last_outcome_survives_a_reissue_but_not_a_delete() {
        let (registry, _fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let create = || creator.create("bob@example.com".to_owned(), Some("bob".to_owned()));
        create().await.unwrap();
        let outcomes = registry.outcomes();
        outcomes.record_for_tunnel("bob", TunnelOutcome::TunnelDown);

        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        reissuer.reissue("bob".to_owned()).await.unwrap();
        assert_eq!(
            outcomes.last_outcome("bob"),
            Some(TunnelOutcome::TunnelDown)
        );

        let deleter: LiveTunnelsDeleter = admin(&registry);
        deleter.delete("bob".to_owned()).await.unwrap();
        assert_eq!(outcomes.last_outcome("bob"), None);
        create().await.unwrap();
        assert_eq!(outcomes.last_outcome("bob"), None);
    }

    /// With the real rathole server and a rathole client as the device: a
    /// created tunnel is down until its device connects and then takes
    /// visitors, and a deleted one stops routing at once and drops.
    #[tokio::test]
    async fn a_created_tunnel_takes_visitors_once_its_device_connects_until_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = settings(dir.path(), None);
        let control_port = free_loopback_port();
        settings.control.control_addr = ([127, 0, 0, 1], control_port).into();
        let (registry, rathole) = open_registry(&settings).await;
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let tunnels = Tunnels::default();
        tokio::spawn(tunnels.clone().serve(
            rathole.initial_config,
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

    /// With the real rathole server and rathole clients as devices: a
    /// reissued token drops the device connected with the old one, which
    /// keeps retrying and is refused, and a device with the new one
    /// connects.
    #[tokio::test]
    async fn a_reissued_token_drops_the_old_device_and_takes_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = settings(dir.path(), None);
        let control_port = free_loopback_port();
        settings.control.control_addr = ([127, 0, 0, 1], control_port).into();
        let (registry, rathole) = open_registry(&settings).await;
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let tunnels = Tunnels::default();
        tokio::spawn(tunnels.clone().serve(
            rathole.initial_config,
            rathole.changes,
            shutdown_rx.resubscribe(),
        ));
        let creator: LiveTunnelsCreator = admin(&registry);
        let created = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        let old_token = created.tunnel.token.expose();
        let mut old_device = device(&settings, "bob", old_token, shutdown_rx.resubscribe()).await;
        until_connected(&tunnels, "bob", &mut old_device).await;

        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        let reissued = reissuer.reissue("bob".to_owned()).await.unwrap();
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
            .expect("the old token's device should drop");
        // The old device retries every second; each time it is refused.
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            tunnels.connect("bob", tokio::io::duplex(64).1).await,
            Err(TunnelDown),
            "the old token no longer connects"
        );

        let new_token = reissued.tunnel.token.expose();
        let mut new_device = device(&settings, "bob", new_token, shutdown_rx).await;
        until_connected(&tunnels, "bob", &mut new_device).await;
        let _ = shutdown_tx.send(true);
    }
}
