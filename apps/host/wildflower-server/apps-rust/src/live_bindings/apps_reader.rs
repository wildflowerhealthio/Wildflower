//! The [`LiveAppsReader`] binding — reads the catalogue + an app through
//! the concrete `SqliteAppsStore`. See the [module docs](super) for the binding
//! seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{FixedScopeCapability, ScopeClaims};
use wildflowerhealthio_scopes::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_reader_scopes, AppsReader};
use crate::domain::AppsError;

/// Read the catalogue + an app — `Scoped<LiveAppsReader>` in the handler.
pub(crate) type LiveAppsReader = AppsReader<SqliteAppsStore>;

impl FixedScopeCapability for LiveAppsReader {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;
    type Error = AppsError;

    fn required_scopes() -> Vec<Scope> {
        apps_reader_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsReader::new(state.store.clone())
    }
}
