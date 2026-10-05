//! The live tunnel set, and the [`TunnelRegistry`] that changes it while the
//! relay runs.
//!
//! The relay serves the tunnels in `WILDFLOWER_RELAY_TUNNELS` plus those in
//! the [`TunnelStore`]; a name in both is a startup error. Everything that
//! knows about tunnels is built from that one [`TunnelSet`]: the rathole
//! TOML (see [`crate::config`]), the front's route table and the
//! [`Verifier`]'s keys. When the admin API creates or deletes a tunnel, the
//! registry writes the store, re-renders the TOML, which rathole reloads on
//! its own, and swaps the routes ([`Router::replace`]) and keys
//! ([`Verifier::replace`]). A created tunnel's device can connect and sign
//! requests at once; a deleted one's tunnel drops when rathole reloads.
//!
//! Each tunnel has a loopback port, where rathole listens for that device
//! and the front connects. At startup the environment's tunnels take
//! `WILDFLOWER_RELAY_TUNNEL_PORT_BASE` onwards in name order and the stored
//! ones follow, also in name order. A tunnel created later takes the port
//! after the highest one handed out so far, so while the relay runs no port
//! is handed out twice, even after its tunnel is deleted. Ports are not
//! stored: they only join rathole to the front within one process, so a
//! restart numbers them afresh.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
use base64::Engine;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rand::Rng;
use serde::{Serialize, Serializer};
use tokio::sync::Mutex;

use crate::config;
use crate::names;
use crate::route::{is_dns_label, RouteTable, Router};
use crate::settings::{ControlSettings, FrontSettings, RelaySettings, Secret, Tunnel};
use crate::site::signature::{unix_now, Verifier};
use crate::store::{StoredTunnel, TunnelStore};

/// How many random bytes make a created tunnel's token.
const TOKEN_BYTES: usize = 32;

/// The longest email accepted, in bytes.
const MAX_EMAIL_LEN: usize = 254;

/// Where a live tunnel comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// `WILDFLOWER_RELAY_TUNNELS`.
    Env,
    /// The [`TunnelStore`], through the admin API.
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

    /// Each tunnel's name and loopback address, for a [`RouteTable`].
    #[must_use]
    pub fn addrs(&self) -> Vec<(String, SocketAddr)> {
        self.iter()
            .map(|live| (live.tunnel.name.clone(), live.addr()))
            .collect()
    }

    /// Each tunnel's name and token, for the [`Verifier`].
    #[must_use]
    pub fn tunnels(&self) -> Vec<Tunnel> {
        self.iter().map(|live| live.tunnel.clone()).collect()
    }
}

/// A live tunnel as `GET /api/tunnels` lists it: no token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TunnelInfo {
    pub name: String,
    /// `None` for a tunnel from the environment.
    pub email: Option<String>,
    /// `<tunnel name>.<domain>`.
    pub public_host: String,
    /// Unix epoch seconds; `None` for a tunnel from the environment.
    pub created_at: Option<i64>,
    pub source: Source,
}

/// A tunnel just created, as `POST /api/tunnels` answers. The only place its
/// token is ever shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CreatedTunnel {
    pub name: String,
    #[serde(serialize_with = "expose")]
    pub token: Secret,
    /// `<tunnel name>.<domain>`.
    pub public_host: String,
}

fn expose<S: Serializer>(secret: &Secret, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(secret.expose())
}

/// Why the registry refused a change.
#[derive(Debug)]
pub enum TunnelError {
    /// The name is not a lowercase DNS label.
    InvalidName,
    /// The email is empty, too long or not `local@domain`.
    InvalidEmail,
    /// The name is one the relay keeps for itself
    /// ([`FrontSettings::is_reserved`]).
    Reserved,
    /// A live tunnel already has the name.
    Taken,
    /// No tunnel has the name.
    NotFound,
    /// The tunnel comes from `WILDFLOWER_RELAY_TUNNELS`, so only the
    /// environment can remove it.
    FromEnvironment,
    /// No free name or port is left.
    Exhausted(&'static str),
    /// Storing, rendering or the clock failed.
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for TunnelError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error)
    }
}

/// The live [`TunnelSet`] and everything built from it, changed together.
pub struct TunnelRegistry {
    config_path: PathBuf,
    control: ControlSettings,
    front: FrontSettings,
    store: TunnelStore,
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
        let store_path = settings.state_dir.join(TunnelStore::FILE_NAME);
        let (store, stored) = tokio::task::spawn_blocking(move || {
            let store = TunnelStore::open(&store_path)?;
            let stored = store
                .list()
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

    fn public_host(&self, name: &str) -> String {
        format!("{name}.{}", self.front.domain)
    }

    /// Every live tunnel, by name.
    pub async fn list(&self) -> Vec<TunnelInfo> {
        self.set
            .lock()
            .await
            .iter()
            .map(|live| TunnelInfo {
                name: live.tunnel.name.clone(),
                email: live.stored.as_ref().map(|(email, _)| email.clone()),
                public_host: self.public_host(&live.tunnel.name),
                created_at: live.stored.as_ref().map(|&(_, created_at)| created_at),
                source: live.source(),
            })
            .collect()
    }

    /// Create and store a tunnel for `email`, named `name` or, without one,
    /// two random words (see [`names`]), with a random token.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub async fn create(
        &self,
        email: &str,
        name: Option<&str>,
    ) -> Result<CreatedTunnel, TunnelError> {
        let email = valid_email(email).ok_or(TunnelError::InvalidEmail)?;
        let mut set = self.set.lock().await;
        // Panics only if the OS has no randomness to give.
        let mut rng = UnwrapErr(SysRng);
        let name = match name {
            Some(name) if !is_dns_label(name) => return Err(TunnelError::InvalidName),
            Some(name) if self.front.is_reserved(name) => return Err(TunnelError::Reserved),
            Some(name) if set.get(name).is_some() => return Err(TunnelError::Taken),
            Some(name) => name.to_owned(),
            None => names::generate_unused(&mut rng, |name| {
                set.get(name).is_some() || self.front.is_reserved(name)
            })
            .ok_or(TunnelError::Exhausted("no unused tunnel name was drawn"))?,
        };
        let mut token = [0; TOKEN_BYTES];
        rng.fill_bytes(&mut token);
        let stored = StoredTunnel {
            tunnel: Tunnel {
                name: name.clone(),
                token: Secret::new(BASE64_URL.encode(token)),
            },
            email,
            created_at: unix_now()?,
        };

        let mut next = set.clone();
        next.add(
            stored.tunnel.clone(),
            Some((stored.email.clone(), stored.created_at)),
        )
        .map_err(|_| TunnelError::Exhausted("no loopback port is left"))?;
        let inserted = stored.clone();
        self.on_store(move |store| store.insert(&inserted)).await?;
        if let Err(error) = self.apply(&next).await {
            let undo_name = name.clone();
            if let Err(undo) = self.on_store(move |store| store.delete(&undo_name)).await {
                tracing::error!(tunnel = %name, "tunnel stored but not served: {undo:#}");
            }
            return Err(error.into());
        }
        *set = next;
        tracing::info!(tunnel = %name, "tunnel created");
        Ok(CreatedTunnel {
            public_host: self.public_host(&name),
            name,
            token: stored.tunnel.token,
        })
    }

    /// Delete the stored tunnel named `name`.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub async fn delete(&self, name: &str) -> Result<(), TunnelError> {
        let mut set = self.set.lock().await;
        let live = set.get(name).ok_or(TunnelError::NotFound)?;
        let Some((email, created_at)) = live.stored.clone() else {
            return Err(TunnelError::FromEnvironment);
        };
        let stored = StoredTunnel {
            tunnel: live.tunnel.clone(),
            email,
            created_at,
        };

        let mut next = set.clone();
        next.remove(name);
        let deleted_name = name.to_owned();
        self.on_store(move |store| store.delete(&deleted_name))
            .await?;
        if let Err(error) = self.apply(&next).await {
            if let Err(undo) = self.on_store(move |store| store.insert(&stored)).await {
                tracing::error!(tunnel = %name, "tunnel served but no longer stored: {undo:#}");
            }
            return Err(error.into());
        }
        *set = next;
        tracing::info!(tunnel = %name, "tunnel deleted");
        Ok(())
    }

    /// Run `op` on the store on a blocking thread: SQLite blocks while it
    /// writes and syncs the file.
    async fn on_store<T: Send + 'static>(
        &self,
        op: impl FnOnce(&TunnelStore) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || op(&store))
            .await
            .context("a tunnel store task panicked")?
    }

    /// Render `set` for rathole, then swap the routes and keys to it.
    async fn apply(&self, set: &TunnelSet) -> anyhow::Result<()> {
        config::write_config(&self.config_path, &self.control, set).await?;
        self.router.replace(RouteTable::from_addrs(set.addrs()));
        self.verifier.replace(&set.tunnels());
        Ok(())
    }
}

/// `email` trimmed, if it is at most [`MAX_EMAIL_LEN`] bytes of `local@domain`
/// with neither part empty and no whitespace or control characters. The
/// email only records who a tunnel belongs to, so this is not a full RFC
/// 5322 check.
fn valid_email(email: &str) -> Option<String> {
    let email = email.trim();
    let (local, domain) = email.rsplit_once('@')?;
    let valid = email.len() <= MAX_EMAIL_LEN
        && !local.is_empty()
        && !domain.is_empty()
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    valid.then(|| email.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashSet;

    use proptest::prelude::*;

    use super::*;

    const NOISE_PRIVATE_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    /// Settings for `relay.example.com` with `tunnels` in the environment,
    /// the given port base and admin key, keeping state in `state_dir`.
    pub(crate) fn settings(
        state_dir: &std::path::Path,
        tunnels: &str,
        port_base: u16,
        admin_key: Option<&str>,
    ) -> RelaySettings {
        let state_dir = state_dir.display().to_string();
        let port_base = port_base.to_string();
        RelaySettings::from_lookup(|name| match name {
            "WILDFLOWER_RELAY_DOMAIN" => Some("relay.example.com".to_owned()),
            "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY" => Some(NOISE_PRIVATE_KEY.to_owned()),
            "WILDFLOWER_RELAY_TUNNELS" => Some(tunnels.to_owned()),
            "WILDFLOWER_RELAY_TUNNEL_PORT_BASE" => Some(port_base.clone()),
            "WILDFLOWER_RELAY_STATE_DIR" => Some(state_dir.clone()),
            "WILDFLOWER_RELAY_ADMIN_KEY" => admin_key.map(str::to_owned),
            _ => None,
        })
        .expect("test settings")
    }

    /// A registry over a fresh state directory, kept alive by the returned
    /// guard, writing its TOML to `relay.toml` there.
    pub(crate) async fn registry(
        tunnels: &str,
        admin_key: Option<&str>,
    ) -> (TunnelRegistry, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        (open(&dir, tunnels, admin_key).await, dir)
    }

    /// The registry the relay builds at startup in `dir`.
    async fn open(
        dir: &tempfile::TempDir,
        tunnels: &str,
        admin_key: Option<&str>,
    ) -> TunnelRegistry {
        TunnelRegistry::open(
            dir.path().join("relay.toml"),
            &settings(dir.path(), tunnels, 5201, admin_key),
        )
        .await
        .expect("registry")
    }

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
            .set
            .lock()
            .await
            .iter()
            .map(|live| (live.tunnel.name.clone(), live.port))
            .collect()
    }

    #[test]
    fn the_environment_takes_the_first_ports_in_name_order_then_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let control = settings(dir.path(), "carol=t3,alice=t1", 6000, None).control;
        let stored = StoredTunnel {
            tunnel: Tunnel {
                name: "bob".to_owned(),
                token: Secret::new("t2"),
            },
            email: "bob@example.com".to_owned(),
            created_at: 1,
        };
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

    #[tokio::test]
    async fn create_and_delete_rewrite_the_rathole_config() {
        let (registry, dir) = registry("alice=t1", None).await;
        let created = registry
            .create("bob@example.com", Some("bob"))
            .await
            .unwrap();
        assert_eq!(created.public_host, "bob.relay.example.com");
        assert_eq!(BASE64_URL.decode(created.token.expose()).unwrap().len(), 32);
        let services = rathole_services(&dir).await;
        assert_eq!(services.len(), 2);
        assert_eq!(
            services["bob"],
            (
                "127.0.0.1:5202".to_owned(),
                Some(created.token.expose().to_owned())
            )
        );

        registry.delete("bob").await.unwrap();
        let services = rathole_services(&dir).await;
        assert_eq!(services.keys().collect::<Vec<_>>(), ["alice"]);
    }

    #[tokio::test]
    async fn create_validates_the_name_and_email() {
        let (registry, _dir) = registry("alice=t1", None).await;
        for (email, name) in [
            ("bob@example.com", "Bob"),
            ("bob@example.com", "bob.example"),
            ("bob@example.com", "-bob"),
            ("bob@example.com", ""),
        ] {
            let result = registry.create(email, Some(name)).await;
            assert!(matches!(result, Err(TunnelError::InvalidName)), "{name:?}");
        }
        for email in ["", "bob", "@example.com", "bob@", "bob @example.com"] {
            let result = registry.create(email, Some("bob")).await;
            assert!(
                matches!(result, Err(TunnelError::InvalidEmail)),
                "{email:?}"
            );
        }
        let result = registry.create("bob@example.com", Some("admin")).await;
        assert!(matches!(result, Err(TunnelError::Reserved)));
        let result = registry.create("bob@example.com", Some("alice")).await;
        assert!(matches!(result, Err(TunnelError::Taken)));
        registry
            .create("bob@example.com", Some("bob"))
            .await
            .unwrap();
        let result = registry.create("carol@example.com", Some("bob")).await;
        assert!(matches!(result, Err(TunnelError::Taken)));
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
        assert_eq!(listed[0].name, "alice");
        assert_eq!(listed[0].source, Source::Env);
        assert_eq!(listed[0].email, None);
        assert_eq!(listed[1].source, Source::Store);
        assert_eq!(listed[1].email.as_deref(), Some("bob@example.com"));
        assert!(listed[1].created_at.is_some());

        assert!(matches!(
            registry.delete("alice").await,
            Err(TunnelError::FromEnvironment)
        ));
        assert!(matches!(
            registry.delete("nobody").await,
            Err(TunnelError::NotFound)
        ));
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

        let restarted = open(&dir, "env-one=t1,env-two=t2", None).await;
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

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        /// A default name is a DNS label and contains no fragment of the
        /// email it was created for. The fragments are longer than any
        /// listed word, so only a name built from the email could match.
        #[test]
        fn default_names_never_contain_fragments_of_the_email(
            local in "[a-z0-9]{6,20}",
            domain in "[a-z0-9]{6,20}",
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let created = runtime.block_on(async {
                let (registry, _dir) = registry("", None).await;
                registry.create(&format!("{local}@{domain}.example"), None).await
            });
            let created = created.unwrap();
            prop_assert!(is_dns_label(&created.name));
            prop_assert!(!created.name.contains(&local), "{}", created.name);
            prop_assert!(!created.name.contains(&domain), "{}", created.name);
        }
    }
}
