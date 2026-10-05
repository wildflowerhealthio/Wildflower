//! The [`CachedTunnelStore`] — a [`TunnelStore`] that keeps the stored
//! tunnels' names and tokens in memory as well, for the lookups the relay
//! makes on every connection and every signed request.
//!
//! It wraps another store (the relay's `SqliteTunnelStore`) and loads every
//! stored tunnel when it is built. Each insert or delete that the wrapped
//! store commits changes the cache in the same call, so the two cannot
//! disagree. That holds only while this process is the one writer of the
//! wrapped store, as the relay is of `tunnels.db` in its state directory.
//!
//! The cache is read through [`ServedTunnels`]: the front's
//! [`Router`](crate::Router) routes a tunnel's hostname only while its name
//! is there, and the site's [`Verifier`](crate::Verifier) checks a tunnel's
//! signatures against the token there. Those lookups never block or fail,
//! unlike the [`TunnelStore`] methods, which go to the wrapped store.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock, RwLockWriteGuard};

use crate::domain::{StoredTunnel, Tunnel, TunnelError, TunnelStore};
use crate::settings::Secret;

/// A [`TunnelStore`] over `S` that keeps the stored tunnels' names and
/// tokens in memory, read through [`Self::served`]. Cheap to clone if `S`
/// is; clones share the cache.
#[derive(Debug, Clone)]
pub struct CachedTunnelStore<S> {
    inner: S,
    served: Arc<ServedTunnels>,
}

impl<S: TunnelStore> CachedTunnelStore<S> {
    /// Wrap `inner`, loading every tunnel it holds into the cache.
    ///
    /// # Errors
    ///
    /// Whatever listing `inner`'s tunnels fails with.
    pub fn new(inner: S) -> Result<Self, TunnelError> {
        let tunnels: Vec<Tunnel> = inner
            .list_tunnels()?
            .into_iter()
            .map(|stored| stored.tunnel)
            .collect();
        Ok(Self {
            inner,
            served: Arc::new(ServedTunnels::new(&tunnels)),
        })
    }

    /// The stored tunnels' names and tokens, which follow every insert and
    /// delete through this store.
    #[must_use]
    pub fn served(&self) -> Arc<ServedTunnels> {
        Arc::clone(&self.served)
    }
}

/// The wrapped store's, changing the cache after each insert or delete it
/// commits.
impl<S: TunnelStore> TunnelStore for CachedTunnelStore<S> {
    fn list_tunnels(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
        self.inner.list_tunnels()
    }

    fn contains_tunnel(&self, name: &str) -> Result<bool, TunnelError> {
        self.inner.contains_tunnel(name)
    }

    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<bool, TunnelError> {
        let inserted = self.inner.insert_tunnel(stored)?;
        if inserted {
            self.served.insert(&stored.tunnel);
        }
        Ok(inserted)
    }

    fn delete_tunnel(&self, name: &str) -> Result<Option<StoredTunnel>, TunnelError> {
        let deleted = self.inner.delete_tunnel(name)?;
        if deleted.is_some() {
            self.served.remove(name);
        }
        Ok(deleted)
    }
}

/// Tunnel name → token, for each stored tunnel: what a
/// [`CachedTunnelStore`] keeps in memory.
#[derive(Debug, Default)]
pub struct ServedTunnels {
    tokens: RwLock<HashMap<String, Secret>>,
}

impl ServedTunnels {
    /// Hold `tunnels`. Outside tests the relay builds one only through
    /// [`CachedTunnelStore::new`].
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

    /// Whether the tunnel named `name` is stored.
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.tokens
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(name)
    }

    /// The token of the tunnel named `name`, if it is stored.
    #[must_use]
    pub fn token(&self, name: &str) -> Option<Secret> {
        self.tokens
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }

    /// Hold `tunnel`, for lookups from now on. Only the
    /// [`CachedTunnelStore`] (and tests) change what is held.
    pub(crate) fn insert(&self, tunnel: &Tunnel) {
        self.tokens_mut()
            .insert(tunnel.name.clone(), tunnel.token.clone());
    }

    /// Stop holding the tunnel named `name`. Connections already piped are
    /// unaffected; only lookups from now on miss it.
    pub(crate) fn remove(&self, name: &str) {
        self.tokens_mut().remove(name);
    }

    fn tokens_mut(&self) -> RwLockWriteGuard<'_, HashMap<String, Secret>> {
        // A poisoned lock only means a writer panicked mid-insert or -remove
        // of one tunnel; the map inside is still whole.
        self.tokens.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};

    /// The cache starts with what is stored and follows each insert and
    /// delete the store commits, but not one it refuses or misses.
    #[test]
    fn the_cache_follows_what_the_store_commits() {
        let inner = FakeTunnelStore::default();
        inner.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let store = CachedTunnelStore::new(inner).unwrap();
        let served = store.served();
        assert_eq!(
            served.token("alice").as_ref().map(Secret::expose),
            Some("alice-token")
        );

        assert!(store.insert_tunnel(&stored_tunnel("bob")).unwrap());
        assert!(served.contains("bob"));
        let mut taken = stored_tunnel("bob");
        taken.tunnel.token = Secret::new("other-token");
        assert!(!store.insert_tunnel(&taken).unwrap());
        assert_eq!(
            served.token("bob").as_ref().map(Secret::expose),
            Some("bob-token")
        );

        assert!(store.delete_tunnel("alice").unwrap().is_some());
        assert!(!served.contains("alice"));
        assert!(store.delete_tunnel("nobody").unwrap().is_none());
        assert!(served.contains("bob"));
    }
}
