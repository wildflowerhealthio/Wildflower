//! The [`LiveTunnelsReader`] binding — lists the tunnels through the
//! concrete `SqliteTunnelStore`. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use super::state::TunnelRegistry;
use super::{on_blocking, AdminCapability};
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::TunnelsReader;
use crate::domain::{StoredTunnel, TunnelError};

/// Read the tunnels — `Admin<LiveTunnelsReader>` in the list handler.
pub(crate) struct LiveTunnelsReader {
    reader: Arc<TunnelsReader<SqliteTunnelStore>>,
}

impl AdminCapability for LiveTunnelsReader {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            reader: Arc::new(TunnelsReader::new(state.store.clone(), state.front.clone())),
        }
    }
}

impl LiveTunnelsReader {
    /// Every tunnel, by name (see [`TunnelsReader::list`]).
    pub(crate) async fn list(&self) -> Result<Vec<StoredTunnel>, TunnelError> {
        let reader = Arc::clone(&self.reader);
        on_blocking(move || reader.list()).await
    }

    /// `<name>.<domain>`, where the tunnel named `name` is served.
    pub(crate) fn public_host(&self, name: &str) -> String {
        self.reader.public_host(name)
    }
}
