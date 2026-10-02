//! The [`LiveAppsCreator`] binding — registers a new app through the
//! concrete `SqliteAppsStore`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_creator_scopes, AppsCreator};

/// Register a new app — `Scoped<LiveAppsCreator>` in the create handler.
pub(crate) type LiveAppsCreator = AppsCreator<SqliteAppsStore>;

impl FixedScopeCapability for LiveAppsCreator {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_creator_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsCreator::new(state.store.clone())
    }
}
