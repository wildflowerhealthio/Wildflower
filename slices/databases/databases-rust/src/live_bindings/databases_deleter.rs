//! The [`LiveDatabasesDeleter`] binding — the [`DatabasesDeleter`] delete facade
//! monomorphized over the concrete [`FilesystemDatabaseFiles`] adapter, built from
//! the [`DatabasesState`] composition seam. See the [module docs](super).

use std::sync::Arc;

use scope_capabilities_rust::{Capability, ScopeClaims};
use scopes_rust::{Grant, Scope};

use super::state::DatabasesState;
use crate::adapters::FilesystemDatabaseFiles;
use crate::domain::capabilities::DatabasesDeleter;
use crate::domain::DatabaseError;

/// Delete a catalogued database — `Scoped<LiveDatabasesDeleter>` in the delete
/// handler.
pub(crate) type LiveDatabasesDeleter = DatabasesDeleter<FilesystemDatabaseFiles>;

impl Capability for LiveDatabasesDeleter {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;
    type Error = DatabaseError;

    // Empty — the data-dependent flavour; see `LiveDatabasesReader`'s binding.
    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: Grant) -> Self {
        DatabasesDeleter::new(state.files.clone(), state.catalogue(), granted)
    }
}
