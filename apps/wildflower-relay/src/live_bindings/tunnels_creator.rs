//! The [`LiveTunnelsCreator`] binding — creates a tunnel through the
//! concrete `SqliteTunnelStore` and serves it through the registry. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

use super::state::{Change, TunnelRegistry};
use super::AdminCapability;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::TunnelsCreator;
use crate::domain::{StoredTunnel, TunnelError};
use crate::site::signature::unix_now;

/// Create a tunnel — `Admin<LiveTunnelsCreator>` in the create handler.
pub(crate) struct LiveTunnelsCreator {
    creator: Arc<TunnelsCreator<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl AdminCapability for LiveTunnelsCreator {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            creator: Arc::new(TunnelsCreator::new(
                state.store.clone(),
                state.front.clone(),
            )),
            registry: state,
        }
    }
}

impl LiveTunnelsCreator {
    /// Create and store a tunnel for `email`, named `name` or, without one,
    /// two random words, with a random token (see
    /// [`TunnelsCreator::create`]), and serve it.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub(crate) async fn create(
        &self,
        email: String,
        name: Option<String>,
    ) -> Result<StoredTunnel, TunnelError> {
        let (creator, undoer) = (Arc::clone(&self.creator), Arc::clone(&self.creator));
        let created = self
            .registry
            .change(
                Change::Created,
                move || {
                    // Panics only if the OS has no randomness to give.
                    let mut rng = UnwrapErr(SysRng);
                    creator.create(&email, name.as_deref(), &mut rng, || {
                        unix_now()
                            .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
                    })
                },
                move |created| undoer.undo(created),
                "tunnel stored but not served",
            )
            .await?;
        tracing::info!(tunnel = %created.tunnel.name, "tunnel created");
        Ok(created)
    }

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    pub(crate) fn public_host(&self, name: &str) -> String {
        self.creator.public_host(name)
    }
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
    use base64::Engine;
    use rathole::{ConfigChange, ServerServiceChange};

    use super::*;
    use crate::config;
    use crate::domain::TunnelStore;
    use crate::live_bindings::LiveTunnelsDeleter;
    use crate::test_support::{admin, registry};

    /// A created tunnel is sent to rathole as a service and routes at once;
    /// a deleted one is deleted from rathole and stops routing.
    #[tokio::test]
    async fn create_and_delete_serve_the_change() {
        let (registry, mut fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let created = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        assert_eq!(creator.public_host("bob"), "bob.relay.example.com");
        let token = created.tunnel.token.expose();
        assert_eq!(BASE64_URL.decode(token).unwrap().len(), 32);
        assert_eq!(
            fixture.rathole.changes.recv().await,
            Some(ConfigChange::ServerChange(ServerServiceChange::Add(
                config::service(&created.tunnel)
            )))
        );
        let router = registry.router();
        assert!(router.resolve("bob.relay.example.com").is_some());

        let deleter: LiveTunnelsDeleter = admin(&registry);
        deleter.delete("bob".to_owned()).await.unwrap();
        assert_eq!(
            fixture.rathole.changes.recv().await,
            Some(ConfigChange::ServerChange(ServerServiceChange::Delete(
                "bob".to_owned()
            )))
        );
        assert!(router.resolve("bob.relay.example.com").is_none());
    }

    /// A refused create leaves the store and what is served alone; the full
    /// matrix of refusals is the capability's tests.
    #[tokio::test]
    async fn refused_creates_change_nothing() {
        let (registry, mut fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let create =
            |email: &str, name: &str| creator.create(email.to_owned(), Some(name.to_owned()));
        assert_eq!(
            create("bob@example.com", "Bob").await.unwrap_err(),
            TunnelError::InvalidName
        );
        assert_eq!(
            create("bob", "bob").await.unwrap_err(),
            TunnelError::InvalidEmail
        );
        create("bob@example.com", "bob").await.unwrap();
        assert_eq!(
            create("carol@example.com", "bob").await.unwrap_err(),
            TunnelError::Taken
        );
        assert_eq!(registry.store.list_tunnels().unwrap().len(), 1);
        assert!(fixture.rathole.changes.try_recv().is_ok(), "bob was served");
        assert!(
            fixture.rathole.changes.try_recv().is_err(),
            "nothing else was"
        );
    }
}
