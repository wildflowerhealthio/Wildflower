//! The [`TunnelRegistry`] — the admin API's router state: the live
//! [`TunnelSet`] and everything built from it, changed together while the
//! relay runs, and the [`SqliteTunnelStore`] the capabilities are lifted
//! from.
//!
//! At startup it opens the store, builds the live set from the stored
//! tunnels, and renders the rathole TOML (see [`crate::config`]), the
//! front's route table and the [`Verifier`]'s keys from it. A capability
//! binding changes it through `TunnelRegistry::change`: the capability
//! decides the change and writes the store, then the registry re-renders
//! the TOML, which rathole reloads on its own, and swaps the routes
//! ([`Router::replace`]) and keys ([`Verifier::replace`]). If that fails the
//! capability's undo puts the store back, so on an error nothing has
//! changed. A created tunnel's device can connect and sign requests at once;
//! a deleted one's tunnel drops when rathole reloads.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use tokio::sync::Mutex;

use super::on_blocking;
use crate::config;
use crate::db::SqliteTunnelStore;
use crate::domain::{LiveTunnel, StoredTunnel, TunnelError, TunnelSet, TunnelStore};
use crate::route::{RouteTable, Router};
use crate::settings::{ControlSettings, FrontSettings, RelaySettings};
use crate::site::signature::Verifier;

/// The live [`TunnelSet`] and everything built from it, changed together.
pub struct TunnelRegistry {
    /// The store the capabilities are lifted from.
    pub(crate) store: SqliteTunnelStore,
    pub(crate) front: FrontSettings,
    config_path: PathBuf,
    control: ControlSettings,
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
    /// live set from it, and write the rathole TOML for it to
    /// `config_path`.
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be opened or read, the live set
    /// cannot be built (see [`TunnelSet::new`]) or the TOML cannot be
    /// written.
    pub async fn open(config_path: PathBuf, settings: &RelaySettings) -> anyhow::Result<Self> {
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
        let set = TunnelSet::new(settings.control.tunnel_port_base, stored)?;
        config::write_config(&config_path, &settings.control, &set).await?;
        let router = Router::new(
            &settings.front.domain,
            settings.front.local_hostnames(),
            RouteTable::from_addrs(set.addrs()),
        );
        let verifier = Verifier::new(&set.tunnels(), settings.admin_key.clone());
        Ok(Self {
            store,
            front: settings.front.clone(),
            config_path,
            control: settings.control.clone(),
            router: Arc::new(router),
            verifier: Arc::new(verifier),
            set: Mutex::new(set),
        })
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
    pub async fn list(&self) -> Vec<LiveTunnel> {
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
        if let Err(error) = self.apply(&next).await {
            let name = changed.tunnel.name.clone();
            if let Err(undo_error) = on_blocking(move || undo(&changed)).await {
                tracing::error!(tunnel = %name, "{undo_failed}: {undo_error}");
            }
            return Err(error);
        }
        *set = next;
        Ok(changed)
    }

    /// Render `set` for rathole, then swap the routes and keys to it.
    async fn apply(&self, set: &TunnelSet) -> Result<(), TunnelError> {
        config::write_config(&self.config_path, &self.control, set)
            .await
            .map_err(|e| TunnelError::infrastructure("rendering the rathole config failed", e))?;
        self.router.replace(RouteTable::from_addrs(set.addrs()));
        self.verifier.replace(&set.tunnels());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashSet};

    use super::*;
    use crate::domain::test_fake::stored_tunnel;
    use crate::live_bindings::{LiveTunnelsCreator, LiveTunnelsDeleter};
    use crate::test_support::{admin, open_registry, rathole_services, registry};

    async fn ports(registry: &TunnelRegistry) -> BTreeMap<String, u16> {
        registry
            .list()
            .await
            .into_iter()
            .map(|live| (live.stored.tunnel.name, live.port))
            .collect()
    }

    /// At startup the stored tunnels are served from the port base in name
    /// order: in the rathole TOML, the routes and the verifier's keys.
    #[tokio::test]
    async fn opening_serves_the_stored_tunnels_in_name_order() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SqliteTunnelStore::open(&dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
        for name in ["carol", "alice"] {
            store.insert_tunnel(&stored_tunnel(name)).unwrap();
        }
        drop(store);

        let registry = open_registry(&dir, None).await;
        assert_eq!(
            ports(&registry).await,
            BTreeMap::from([("alice".to_owned(), 5201), ("carol".to_owned(), 5202)])
        );
        let services = rathole_services(&dir).await;
        assert_eq!(
            services["carol"],
            ("127.0.0.1:5202".to_owned(), Some("carol-token".to_owned()))
        );
        assert!(registry
            .router()
            .resolve("alice.relay.example.com")
            .is_some());
    }

    /// No port is live twice, and none is handed out again within a run;
    /// a restart numbers the survivors afresh from the base, still without
    /// overlap.
    #[tokio::test]
    async fn ports_are_never_reused_across_creates_deletes_and_restarts() {
        let (registry, dir) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let deleter: LiveTunnelsDeleter = admin(&registry);
        let mut handed_out = HashSet::new();
        for round in 0..5 {
            for i in 0..3 {
                let name = format!("t{round}-{i}");
                creator
                    .create("ops@example.com".to_owned(), Some(name.clone()))
                    .await
                    .unwrap();
                let port = ports(&registry).await[&name];
                assert!(handed_out.insert(port), "port {port} handed out twice");
            }
            deleter.delete(format!("t{round}-0")).await.unwrap();
        }
        let live = ports(&registry).await;
        drop((creator, deleter, registry));

        let restarted = open_registry(&dir, None).await;
        let after = ports(&restarted).await;
        assert_eq!(
            after.keys().collect::<Vec<_>>(),
            live.keys().collect::<Vec<_>>()
        );
        let mut by_port: Vec<_> = after.values().copied().collect();
        by_port.sort_unstable();
        let expected: Vec<u16> = (5201..).take(after.len()).collect();
        assert_eq!(by_port, expected, "{after:?}");
        let services = rathole_services(&dir).await;
        for (name, port) in &after {
            assert_eq!(services[name].0, format!("127.0.0.1:{port}"));
        }
    }
}
