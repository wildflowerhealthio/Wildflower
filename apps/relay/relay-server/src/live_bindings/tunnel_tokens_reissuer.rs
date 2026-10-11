//! The [`LiveTunnelTokensReissuer`] binding — reissues a tunnel's token
//! through the concrete `SqliteTunnelStore` and serves the new one through
//! the registry. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

use super::state::{Change, TunnelRegistry};
use super::AdminCapability;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::TunnelTokensReissuer;
use crate::domain::{StoredTunnel, TunnelError};

/// Reissue a tunnel's token — `Admin<LiveTunnelTokensReissuer>` in the
/// reissue handler.
pub(crate) struct LiveTunnelTokensReissuer {
    reissuer: Arc<TunnelTokensReissuer<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl AdminCapability for LiveTunnelTokensReissuer {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            reissuer: Arc::new(TunnelTokensReissuer::new(state.store.clone())),
            registry: state,
        }
    }
}

impl LiveTunnelTokensReissuer {
    /// Replace the token of the tunnel named `name` with a random one (see
    /// [`TunnelTokensReissuer::reissue`]) and serve it, so the old token
    /// stops working and a device connected with it drops. Returns the
    /// tunnel as now stored.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub(crate) async fn reissue(&self, name: String) -> Result<StoredTunnel, TunnelError> {
        let (reissuer, undoer) = (Arc::clone(&self.reissuer), Arc::clone(&self.reissuer));
        let reissued = self
            .registry
            .change(
                Change::TokenReissued,
                move || {
                    // Panics only if the OS has no randomness to give.
                    let mut rng = UnwrapErr(SysRng);
                    reissuer.reissue(&name, &mut rng)
                },
                move |reissued| undoer.undo(reissued),
                "token stored but not served",
            )
            .await?;
        tracing::info!(tunnel = %reissued.stored.tunnel.name, "tunnel token reissued");
        Ok(reissued.stored)
    }

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    pub(crate) fn public_host(&self, name: &str) -> String {
        self.registry.front.public_host(name)
    }
}

#[cfg(test)]
mod tests {
    use rathole::{ConfigChange, ServerServiceChange};

    use super::*;
    use crate::config;
    use crate::domain::TunnelStore;
    use crate::live_bindings::LiveTunnelsCreator;
    use crate::test_support::{admin, registry};

    /// A reissued token is sent to rathole as the service added again, with
    /// the new token, and is stored.
    #[tokio::test]
    async fn a_reissued_token_is_served_and_stored() {
        let (registry, mut fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let created = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        fixture.rathole.changes.recv().await.unwrap();

        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        let reissued = reissuer.reissue("bob".to_owned()).await.unwrap();
        assert_ne!(reissued.tunnel.token, created.tunnel.token);
        assert_eq!(
            fixture.rathole.changes.recv().await,
            Some(ConfigChange::ServerChange(ServerServiceChange::Add(
                config::service(&reissued.tunnel)
            )))
        );
        assert_eq!(registry.store.list_tunnels().unwrap(), [reissued]);
    }

    #[tokio::test]
    async fn reissuing_for_an_unknown_tunnel_is_not_found() {
        let (registry, mut fixture) = registry(None).await;
        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        assert_eq!(
            reissuer.reissue("nobody".to_owned()).await.unwrap_err(),
            TunnelError::NotFound
        );
        assert!(fixture.rathole.changes.try_recv().is_err());
    }

    /// Once rathole has stopped, a reissue is undone: the old token stays
    /// stored.
    #[tokio::test]
    async fn a_reissue_rathole_cannot_take_is_undone() {
        let (registry, fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let created = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        drop(fixture.rathole);

        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        let refused = reissuer.reissue("bob".to_owned()).await.unwrap_err();
        assert!(matches!(refused, TunnelError::Infrastructure { .. }));
        assert_eq!(registry.store.list_tunnels().unwrap(), [created]);
    }
}
