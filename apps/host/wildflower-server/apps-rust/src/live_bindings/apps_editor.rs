//! The [`LiveAppsEditor`] binding — edits an app's content / home-screen
//! placement through the concrete `SqliteAppsStore`. See the [module docs](super)
//! for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{FixedScopeCapability, ScopeClaims};
use wildflowerhealthio_scopes::Scope;

use super::state::AppsState;
use crate::db::SqliteAppsStore;
use crate::domain::capabilities::{apps_editor_scopes, AppsEditor};
use crate::domain::AppsError;

/// Edit an app's content / home-screen placement — `Scoped<LiveAppsEditor>` in
/// the handler.
pub(crate) type LiveAppsEditor = AppsEditor<SqliteAppsStore>;

impl FixedScopeCapability for LiveAppsEditor {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;
    type Error = AppsError;

    fn required_scopes() -> Vec<Scope> {
        apps_editor_scopes()
    }

    fn build(state: Arc<AppsState>) -> Self {
        AppsEditor::new(state.store.clone())
    }
}
