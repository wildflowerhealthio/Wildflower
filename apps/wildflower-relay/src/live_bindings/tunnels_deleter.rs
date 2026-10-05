//! The [`LiveTunnelsDeleter`] binding — deletes a tunnel through the
//! concrete `SqliteTunnelStore` and stops serving it through the registry.
//! See the [module docs](super) for the binding seam.

use std::sync::Arc;

use super::state::{Change, TunnelRegistry};
use super::AdminCapability;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::TunnelsDeleter;
use crate::domain::TunnelError;

/// Delete a tunnel — `Admin<LiveTunnelsDeleter>` in the delete handler.
pub(crate) struct LiveTunnelsDeleter {
    deleter: Arc<TunnelsDeleter<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl AdminCapability for LiveTunnelsDeleter {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            deleter: Arc::new(TunnelsDeleter::new(state.store.clone())),
            registry: state,
        }
    }
}

impl LiveTunnelsDeleter {
    /// Delete the tunnel named `name` (see [`TunnelsDeleter::delete`]) and
    /// stop serving it.
    ///
    /// # Errors
    ///
    /// See [`TunnelError`]. On an error nothing has changed.
    pub(crate) async fn delete(&self, name: String) -> Result<(), TunnelError> {
        let (deleter, undoer) = (Arc::clone(&self.deleter), Arc::clone(&self.deleter));
        let deleted = self
            .registry
            .change(
                Change::Deleted,
                move || deleter.delete(&name),
                move |deleted| undoer.undo(deleted),
                "tunnel served but no longer stored",
            )
            .await?;
        tracing::info!(tunnel = %deleted.tunnel.name, "tunnel deleted");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{admin, registry};

    #[tokio::test]
    async fn deleting_an_unknown_tunnel_is_not_found() {
        let (registry, _fixture) = registry(None).await;
        let deleter: LiveTunnelsDeleter = admin(&registry);
        assert_eq!(
            deleter.delete("nobody".to_owned()).await.unwrap_err(),
            TunnelError::NotFound
        );
    }
}
