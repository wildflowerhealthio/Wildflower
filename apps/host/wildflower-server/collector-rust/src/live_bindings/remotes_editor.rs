//! The [`LiveRemotesEditor`] binding — replaces a remote through the concrete
//! `SqliteRemotesStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{FixedScopeCapability, ScopeClaims};
use wildflowerhealthio_scopes::Scope;

use super::state::CollectorState;
use crate::db::SqliteRemotesStore;
use crate::domain::capabilities::{remotes_editor_scopes, RemotesEditor};
use crate::domain::RemoteError;

/// Replace a remote — `Scoped<LiveRemotesEditor>` in the update handler.
pub(crate) type LiveRemotesEditor = RemotesEditor<SqliteRemotesStore>;

impl FixedScopeCapability for LiveRemotesEditor {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;
    type Error = RemoteError;

    fn required_scopes() -> Vec<Scope> {
        remotes_editor_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesEditor::new(state.store.clone())
    }
}
