//! The [`LiveAppsDeleter`] binding — removes an app over the concrete
//! `SqliteAppsStore` + the `SelfHostedAppsService` installer (a self-hosted delete
//! stops the listener and discards the folder). See the [module docs](super) for
//! the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_deleter_scopes, AppsDeleter};
use crate::self_hosted_apps_service::SelfHostedAppsService;

/// Remove an app — `Scoped<LiveAppsDeleter>` in the handler.
pub(crate) type LiveAppsDeleter = AppsDeleter<SqliteAppsStore, SelfHostedAppsService>;

impl FixedScopeCapability for LiveAppsDeleter {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_deleter_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsDeleter::new(state.store.clone(), Arc::clone(&state.self_hosted))
    }
}
