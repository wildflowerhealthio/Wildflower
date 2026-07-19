//! The [`LiveRemotesDeleter`] binding — deletes a remote through the concrete
//! `SqliteRemotesStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::CollectorState;
use crate::db::SqliteRemotesStore;
use crate::domain::capabilities::{remotes_deleter_scopes, RemotesDeleter};

/// Delete a remote — `Scoped<LiveRemotesDeleter>` in the delete handler.
pub(crate) type LiveRemotesDeleter = RemotesDeleter<SqliteRemotesStore>;

impl FixedScopeCapability for LiveRemotesDeleter {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_deleter_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesDeleter::new(state.store.clone())
    }
}
