//! The [`LiveDatabasesReader`] binding — the [`DatabasesReader`] read facade
//! monomorphized over the concrete [`FilesystemDatabaseFiles`] adapter, built from
//! the [`DatabasesState`] composition seam. See the [module docs](super).

use std::sync::Arc;

use scope_capabilities_rust::{Capability, ScopeClaims};
use scopes_rust::{Grant, Scope};

use super::state::DatabasesState;
use crate::adapters::FilesystemDatabaseFiles;
use crate::domain::capabilities::DatabasesReader;

/// Read catalogued databases — `Scoped<LiveDatabasesReader>` in the list/download
/// handlers.
pub(crate) type LiveDatabasesReader = DatabasesReader<FilesystemDatabaseFiles>;

impl Capability for LiveDatabasesReader {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;

    // Empty — the data-dependent flavour: listing needs only authentication, and
    // the per-database read scope is checked in `download` via the descriptor gate
    // inside the capability.
    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: Grant) -> Self {
        DatabasesReader::new(state.files.clone(), state.catalogue(), granted)
    }
}
