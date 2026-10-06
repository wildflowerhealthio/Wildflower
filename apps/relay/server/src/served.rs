//! The tunnels the relay serves: each one's name and token, in one place.
//!
//! The front's [`Router`](crate::Router) routes a tunnel's hostname only
//! while its name is here, and the site's [`Verifier`](crate::Verifier)
//! checks a tunnel's signatures against the token here. The
//! [`TunnelRegistry`](crate::TunnelRegistry) builds it from the store at
//! startup and inserts or removes a tunnel as one is created or deleted, so
//! routing and signing cannot disagree about which tunnels exist. rathole
//! keeps its own services, which the registry sends it each change.

use std::collections::HashMap;
use std::sync::{PoisonError, RwLock, RwLockWriteGuard};

use crate::domain::Tunnel;
use crate::settings::Secret;

/// Tunnel name → token, for each tunnel the relay serves.
#[derive(Debug, Default)]
pub struct ServedTunnels {
    tokens: RwLock<HashMap<String, Secret>>,
}

impl ServedTunnels {
    #[must_use]
    pub fn new(tunnels: &[Tunnel]) -> Self {
        let tokens = tunnels
            .iter()
            .map(|tunnel| (tunnel.name.clone(), tunnel.token.clone()))
            .collect();
        Self {
            tokens: RwLock::new(tokens),
        }
    }

    /// Serve `tunnel`, for lookups from now on.
    pub fn insert(&self, tunnel: &Tunnel) {
        self.tokens_mut()
            .insert(tunnel.name.clone(), tunnel.token.clone());
    }

    /// Stop serving the tunnel named `name`. Connections already piped are
    /// unaffected; only lookups from now on miss it.
    pub fn remove(&self, name: &str) {
        self.tokens_mut().remove(name);
    }

    /// Whether the tunnel named `name` is served.
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.tokens
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(name)
    }

    /// The token of the tunnel named `name`, if it is served.
    #[must_use]
    pub fn token(&self, name: &str) -> Option<Secret> {
        self.tokens
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }

    fn tokens_mut(&self) -> RwLockWriteGuard<'_, HashMap<String, Secret>> {
        // A poisoned lock only means a writer panicked mid-insert or -remove
        // of one tunnel; the map inside is still whole.
        self.tokens.write().unwrap_or_else(PoisonError::into_inner)
    }
}
