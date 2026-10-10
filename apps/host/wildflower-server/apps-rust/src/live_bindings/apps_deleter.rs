//! The [`LiveAppsDeleter`] binding — removes an app through the concrete
//! `SqliteAppsStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{FixedScopeCapability, ScopeClaims};
use wildflowerhealthio_scopes::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_deleter_scopes, AppsDeleter};
use crate::domain::AppsError;

/// Remove an app — `Scoped<LiveAppsDeleter>` in the delete handler.
pub(crate) type LiveAppsDeleter = AppsDeleter<SqliteAppsStore>;

impl FixedScopeCapability for LiveAppsDeleter {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;
    type Error = AppsError;

    fn required_scopes() -> Vec<Scope> {
        apps_deleter_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsDeleter::new(state.store.clone())
    }
}
