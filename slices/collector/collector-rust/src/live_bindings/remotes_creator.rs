//! The [`LiveRemotesCreator`] binding — creates a remote through the concrete
//! `SqliteRemotesStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::CollectorState;
use crate::db::SqliteRemotesStore;
use crate::domain::capabilities::{remotes_creator_scopes, RemotesCreator};

/// Create a remote — `Scoped<LiveRemotesCreator>` in the create handler.
pub(crate) type LiveRemotesCreator = RemotesCreator<SqliteRemotesStore>;

impl FixedScopeCapability for LiveRemotesCreator {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_creator_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesCreator::new(state.store.clone())
    }
}
