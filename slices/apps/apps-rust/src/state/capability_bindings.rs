//! The `FixedScopeCapability` bindings — where the generic, store-agnostic
//! capabilities in [`crate::domain::capabilities`] meet the concrete
//! [`SqliteAppsStore`] adapter, the [`SelfHostedAppsService`] installer, and the
//! `Arc<AppsState>` router state. Each binding lifts the store + installer + the
//! reserved loopback port out of the state (it never hands the capability the whole
//! state), so `domain/` stays free of both `crate::http` and the concrete adapter
//! types. The `type …Cap` aliases are what the `/apps` admin handlers name in
//! `Scoped<…>`.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{
    apps_creator_scopes, apps_deleter_scopes, apps_editor_scopes, apps_reader_scopes, AppsCreator,
    AppsDeleter, AppsEditor, AppsReader,
};
use crate::self_hosted_apps_service::SelfHostedAppsService;
use crate::state::AppsState;

/// Read the catalogue + per-kind detail — `Scoped<AppsReaderCap>` in the handler.
pub(crate) type AppsReaderCap = AppsReader<SqliteAppsStore>;
/// Register a new cloud / self-hosted app.
pub(crate) type AppsCreatorCap = AppsCreator<SqliteAppsStore, SelfHostedAppsService>;
/// Edit an app's content / home-screen placement.
pub(crate) type AppsEditorCap = AppsEditor<SqliteAppsStore>;
/// Remove an app.
pub(crate) type AppsDeleterCap = AppsDeleter<SqliteAppsStore, SelfHostedAppsService>;

impl FixedScopeCapability for AppsReaderCap {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_reader_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsReader::new(state.store.clone())
    }
}

impl FixedScopeCapability for AppsCreatorCap {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_creator_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsCreator::new(
            state.store.clone(),
            Arc::clone(&state.self_hosted),
            // The host's own loopback port is reserved so an upload never binds
            // over it — lifted here so the handler never touches the state.
            state.loopback_base_url.port().into_iter().collect(),
        )
    }
}

impl FixedScopeCapability for AppsEditorCap {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_editor_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsEditor::new(state.store.clone())
    }
}

impl FixedScopeCapability for AppsDeleterCap {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_deleter_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsDeleter::new(state.store.clone(), Arc::clone(&state.self_hosted))
    }
}
