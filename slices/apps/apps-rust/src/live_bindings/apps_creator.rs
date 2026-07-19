//! The [`LiveAppsCreator`] binding — registers new apps over the concrete
//! `SqliteAppsStore` + the `SelfHostedAppsService` installer, reserving the host's
//! own loopback port against an upload. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_creator_scopes, AppsCreator};
use crate::self_hosted_apps_service::SelfHostedAppsService;

/// Register a new cloud / self-hosted app — `Scoped<LiveAppsCreator>` in the handler.
pub(crate) type LiveAppsCreator = AppsCreator<SqliteAppsStore, SelfHostedAppsService>;

impl FixedScopeCapability for LiveAppsCreator {
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
