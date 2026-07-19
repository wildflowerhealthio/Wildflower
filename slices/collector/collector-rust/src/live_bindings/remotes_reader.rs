//! The [`LiveRemotesReader`] binding — reads remotes through the concrete
//! `SqliteRemotesStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::CollectorState;
use crate::db::SqliteRemotesStore;
use crate::domain::capabilities::{remotes_reader_scopes, RemotesReader};

/// Read remotes — `Scoped<LiveRemotesReader>` in the list/get handlers.
pub(crate) type LiveRemotesReader = RemotesReader<SqliteRemotesStore>;

impl FixedScopeCapability for LiveRemotesReader {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_reader_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesReader::new(state.store.clone())
    }
}
