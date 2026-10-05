//! The [`TunnelRegistry`] — the live [`TunnelSet`] and everything built from
//! it, changed together while the relay runs.
//!
//! At startup it opens the [`SqliteTunnelStore`], builds the live set from
//! the environment and the stored tunnels, and renders the rathole TOML (see
//! [`crate::config`]), the front's route table and the [`Verifier`]'s keys
//! from it. When the admin API creates or deletes a tunnel, the domain
//! [`actions`] decide the change and write the store, then the registry
//! re-renders the TOML, which rathole reloads on its own, and swaps the
//! routes ([`Router::replace`]) and keys ([`Verifier::replace`]). If that
//! fails it undoes the store write, so on an error nothing has changed. A
//! created tunnel's device can connect and sign requests at once; a deleted
//! one's tunnel drops when rathole reloads.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use tokio::sync::Mutex;

use crate::config;
use crate::db::SqliteTunnelStore;
use crate::domain::{actions, LiveTunnel, StoredTunnel, TunnelError, TunnelSet, TunnelStore};
use crate::route::{RouteTable, Router};
use crate::settings::{ControlSettings, FrontSettings, RelaySettings};
use crate::site::signature::{unix_now, Verifier};

/// The live [`TunnelSet`] and everything built from it, changed together.
pub struct TunnelRegistry {
    config_path: PathBuf,
    control: ControlSettings,
    front: FrontSettings,
    store: SqliteTunnelStore,
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
    /// live set from it and the environment, and write the rathole TOML for
    /// it to `config_path`.
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
        let set = TunnelSet::new(&settings.control, stored)?;
        config::write_config(&config_path, &settings.control, &set).await?;
        let router = Router::new(
            &settings.front.domain,
            settings.front.local_hostnames(),
            RouteTable::from_addrs(set.addrs()),
        );
        let verifier = Verifier::new(&set.tunnels(), settings.admin_key.clone());
        Ok(Self {
            config_path,
            control: settings.control.clone(),
            front: settings.front.clone(),
            store,
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

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    #[must_use]
    pub fn public_host(&self, name: &str) -> String {
        format!("{name}.{}", self.front.domain)
    }

    /// Every live tunnel, by name.
    pub async fn list(&self) -> Vec<LiveTunnel> {
        self.set.lock().await.iter().cloned().collect()
    }

    /// Create and store a tunnel for `email`, named `name` or, without one,
    /// two random words, with a random token (see
    /// [`actions::create_tunnel`]), and serve it.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub async fn create(
        &self,
        email: &str,
        name: Option<&str>,
    ) -> Result<StoredTunnel, TunnelError> {
        let mut set = self.set.lock().await;
        let created_at =
            unix_now().map_err(|e| TunnelError::infrastructure("reading the clock failed", e))?;
        let (live, front) = (set.clone(), self.front.clone());
        let (email, name) = (email.to_owned(), name.map(str::to_owned));
        let (stored, next) = self
            .on_store(move |store| {
                // Panics only if the OS has no randomness to give.
                let mut rng = UnwrapErr(SysRng);
                actions::create_tunnel(
                    store,
                    &live,
                    &front,
                    &email,
                    name.as_deref(),
                    &mut rng,
                    created_at,
                )
            })
            .await?;

        let name = stored.tunnel.name.clone();
        if let Err(error) = self.apply(&next).await {
            let undo_name = name.clone();
            if let Err(undo) = self
                .on_store(move |store| store.delete_tunnel(&undo_name))
                .await
            {
                tracing::error!(tunnel = %name, "tunnel stored but not served: {undo}");
            }
            return Err(error);
        }
        *set = next;
        tracing::info!(tunnel = %name, "tunnel created");
        Ok(stored)
    }

    /// Delete the stored tunnel named `name` (see
    /// [`actions::delete_tunnel`]) and stop serving it.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub async fn delete(&self, name: &str) -> Result<(), TunnelError> {
        let mut set = self.set.lock().await;
        let live = set.clone();
        let deleted_name = name.to_owned();
        let (stored, next) = self
            .on_store(move |store| actions::delete_tunnel(store, &live, &deleted_name))
            .await?;

        if let Err(error) = self.apply(&next).await {
            if let Err(undo) = self
                .on_store(move |store| store.insert_tunnel(&stored))
                .await
            {
                tracing::error!(tunnel = %name, "tunnel served but no longer stored: {undo}");
            }
            return Err(error);
        }
        *set = next;
        tracing::info!(tunnel = %name, "tunnel deleted");
        Ok(())
    }

    /// Run `op` on the store on a blocking thread: SQLite blocks while it
    /// writes and syncs the file.
    async fn on_store<T: Send + 'static>(
        &self,
        op: impl FnOnce(&SqliteTunnelStore) -> Result<T, TunnelError> + Send + 'static,
    ) -> Result<T, TunnelError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || op(&store))
            .await
            .map_err(|e| TunnelError::infrastructure("a tunnel store task panicked", e))?
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

    use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
    use base64::Engine;

    use super::*;
    use crate::domain::Source;
    use crate::test_support::{open_registry, registry};

    /// Each service in the rathole config the registry last wrote, as
    /// rathole parses it: name → (bind address, token).
    async fn rathole_services(
        dir: &tempfile::TempDir,
    ) -> BTreeMap<String, (String, Option<String>)> {
        rathole::Config::from_file(&dir.path().join("relay.toml"))
            .await
            .expect("rathole parses the rendered config")
            .server
            .expect("[server]")
            .services
            .into_iter()
            .map(|(name, service)| {
                (
                    name,
                    (service.bind_addr, service.token.map(|t| t.to_string())),
                )
            })
            .collect()
    }

    async fn ports(registry: &TunnelRegistry) -> BTreeMap<String, u16> {
        registry
            .list()
            .await
            .into_iter()
            .map(|live| (live.tunnel.name, live.port))
            .collect()
    }

    #[tokio::test]
    async fn create_and_delete_rewrite_the_rathole_config() {
        let (registry, dir) = registry("alice=t1", None).await;
        let created = registry
            .create("bob@example.com", Some("bob"))
            .await
            .unwrap();
        assert_eq!(
            registry.public_host(&created.tunnel.name),
            "bob.relay.example.com"
        );
        let token = created.tunnel.token.expose();
        assert_eq!(BASE64_URL.decode(token).unwrap().len(), 32);
        let services = rathole_services(&dir).await;
        assert_eq!(services.len(), 2);
        assert_eq!(
            services["bob"],
            ("127.0.0.1:5202".to_owned(), Some(token.to_owned()))
        );

        registry.delete("bob").await.unwrap();
        let services = rathole_services(&dir).await;
        assert_eq!(services.keys().collect::<Vec<_>>(), ["alice"]);
    }

    /// The registry refuses through the actions and leaves the live set as
    /// it was; the full matrix of refusals is the actions' tests.
    #[tokio::test]
    async fn refused_changes_leave_the_live_set_alone() {
        let (registry, _dir) = registry("alice=t1", None).await;
        let result = registry.create("bob@example.com", Some("Bob")).await;
        assert_eq!(result.unwrap_err(), TunnelError::InvalidName);
        let result = registry.create("bob", Some("bob")).await;
        assert_eq!(result.unwrap_err(), TunnelError::InvalidEmail);
        let result = registry.create("bob@example.com", Some("alice")).await;
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        registry
            .create("bob@example.com", Some("bob"))
            .await
            .unwrap();
        let result = registry.create("carol@example.com", Some("bob")).await;
        assert_eq!(result.unwrap_err(), TunnelError::Taken);
        assert_eq!(registry.list().await.len(), 2);
    }

    #[tokio::test]
    async fn environment_tunnels_are_listed_but_not_deletable() {
        let (registry, _dir) = registry("alice=t1", None).await;
        registry
            .create(" bob@example.com ", Some("bob"))
            .await
            .unwrap();
        let listed = registry.list().await;
        assert_eq!(listed[0].tunnel.name, "alice");
        assert_eq!(listed[0].source(), Source::Env);
        assert_eq!(listed[0].stored, None);
        assert_eq!(listed[1].source(), Source::Store);
        let (email, _) = listed[1].stored.as_ref().unwrap();
        assert_eq!(email, "bob@example.com");

        assert_eq!(
            registry.delete("alice").await.unwrap_err(),
            TunnelError::FromEnvironment
        );
        assert_eq!(
            registry.delete("nobody").await.unwrap_err(),
            TunnelError::NotFound
        );
        assert_eq!(registry.list().await.len(), 2);
    }

    /// No port is live twice, and none is handed out again within a run;
    /// a restart numbers the survivors afresh, still without overlap.
    #[tokio::test]
    async fn ports_are_never_reused_across_creates_deletes_and_restarts() {
        let (registry, dir) = registry("env-one=t1,env-two=t2", None).await;
        let mut handed_out = HashSet::new();
        handed_out.extend(ports(&registry).await.into_values());
        for round in 0..5 {
            for i in 0..3 {
                let name = format!("t{round}-{i}");
                registry
                    .create("ops@example.com", Some(&name))
                    .await
                    .unwrap();
                let port = ports(&registry).await[&name];
                assert!(handed_out.insert(port), "port {port} handed out twice");
            }
            registry.delete(&format!("t{round}-0")).await.unwrap();
        }
        let live = ports(&registry).await;
        drop(registry);

        let restarted = open_registry(&dir, "env-one=t1,env-two=t2", None).await;
        let after = ports(&restarted).await;
        assert_eq!(
            after.keys().collect::<Vec<_>>(),
            live.keys().collect::<Vec<_>>()
        );
        let distinct: HashSet<_> = after.values().collect();
        assert_eq!(distinct.len(), after.len(), "{after:?}");
        assert_eq!(after["env-one"], 5201);
        assert_eq!(after["env-two"], 5202);
        let services = rathole_services(&dir).await;
        for (name, port) in &after {
            assert_eq!(services[name].0, format!("127.0.0.1:{port}"));
        }
    }
}
