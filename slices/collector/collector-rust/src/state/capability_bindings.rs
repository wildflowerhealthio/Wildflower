//! The `FixedScopeCapability` bindings — where the generic, store-agnostic
//! capabilities in [`crate::domain::capabilities`] (which document the
//! fixed-scope flavour) meet the concrete [`SqliteRemotesStore`] and the
//! `Arc<CollectorState>` router state. Each binding lifts the store handle out of
//! the state (it never hands the capability the whole state), so `domain/` stays
//! free of both `crate::http` and the concrete adapter type. The `type …Cap`
//! aliases are what the `/collector/remotes` handlers name in `Scoped<…>`.
//!
//! The `Claims` type is the ready-made [`ScopeClaims`] the host's bearer gate
//! (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`) inserts, so this
//! slice scope-gates without depending on gatekeeper's domain claims type.

use std::sync::Arc;

use scopes_rust::Scope;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};

use crate::db::SqliteRemotesStore;
use crate::domain::capabilities::{
    remotes_creator_scopes, remotes_deleter_scopes, remotes_editor_scopes, remotes_reader_scopes,
    RemotesCreator, RemotesDeleter, RemotesEditor, RemotesReader,
};
use crate::state::CollectorState;

/// Read remotes — `Scoped<RemotesReaderCap>` in the list/get handlers.
pub(crate) type RemotesReaderCap = RemotesReader<SqliteRemotesStore>;
/// Create a remote — `Scoped<RemotesCreatorCap>` in the create handler.
pub(crate) type RemotesCreatorCap = RemotesCreator<SqliteRemotesStore>;
/// Replace a remote — `Scoped<RemotesEditorCap>` in the update handler.
pub(crate) type RemotesEditorCap = RemotesEditor<SqliteRemotesStore>;
/// Delete a remote — `Scoped<RemotesDeleterCap>` in the delete handler.
pub(crate) type RemotesDeleterCap = RemotesDeleter<SqliteRemotesStore>;

impl FixedScopeCapability for RemotesReaderCap {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_reader_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesReader::new(state.store.clone())
    }
}

impl FixedScopeCapability for RemotesCreatorCap {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_creator_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesCreator::new(state.store.clone())
    }
}

impl FixedScopeCapability for RemotesEditorCap {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_editor_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesEditor::new(state.store.clone())
    }
}

impl FixedScopeCapability for RemotesDeleterCap {
    type State = Arc<CollectorState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        remotes_deleter_scopes()
    }

    fn build(state: Arc<CollectorState>) -> Self {
        RemotesDeleter::new(state.store.clone())
    }
}
