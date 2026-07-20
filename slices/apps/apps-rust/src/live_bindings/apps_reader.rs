//! The [`LiveAppsReader`] binding — reads the catalogue + per-kind detail through
//! the concrete `SqliteAppsStore`. See the [module docs](super) for the binding
//! seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_reader_scopes, AppsReader};

/// Read the catalogue + per-kind detail — `Scoped<LiveAppsReader>` in the handler.
pub(crate) type LiveAppsReader = AppsReader<SqliteAppsStore>;

impl FixedScopeCapability for LiveAppsReader {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        apps_reader_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsReader::new(state.store.clone())
    }
}
