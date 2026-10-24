//! The [`LiveTunnelsReader`] binding — lists the tunnels through the
//! concrete `SqliteTunnelStore`, and reads each one's last connection
//! outcome from memory. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use super::state::TunnelRegistry;
use super::{on_blocking, AdminCapability};
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::TunnelsReader;
use crate::domain::{StoredTunnel, TunnelError, TunnelOutcome};
use crate::outcomes::ConnectionOutcomes;

/// Read the tunnels — `Admin<LiveTunnelsReader>` in the list handler.
pub(crate) struct LiveTunnelsReader {
    reader: Arc<TunnelsReader<SqliteTunnelStore>>,
    outcomes: Arc<ConnectionOutcomes>,
}

impl AdminCapability for LiveTunnelsReader {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            reader: Arc::new(TunnelsReader::new(
                state.store.clone(),
                state.hostnames.clone(),
            )),
            outcomes: state.outcomes(),
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

    /// The outcome of the last connection to the tunnel named `name` since
    /// the relay started, if there has been one.
    pub(crate) fn last_outcome(&self, name: &str) -> Option<TunnelOutcome> {
        self.outcomes.last_outcome(name)
    }
}
