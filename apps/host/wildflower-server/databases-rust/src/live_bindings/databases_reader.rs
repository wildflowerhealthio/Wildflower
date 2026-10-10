//! The [`LiveDatabasesReader`] binding — the [`DatabasesReader`] read facade
//! monomorphized over the concrete [`FilesystemDatabaseFiles`] adapter, built from
//! the [`DatabasesState`] composition seam. See the [module docs](super).

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{Capability, ScopeClaims};
use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::DatabasesState;
use crate::adapters::FilesystemDatabaseFiles;
use crate::domain::capabilities::DatabasesReader;
use crate::domain::DatabaseError;

/// Read catalogued databases — `Scoped<LiveDatabasesReader>` in the list/download
/// handlers.
pub(crate) type LiveDatabasesReader = DatabasesReader<FilesystemDatabaseFiles>;

impl Capability for LiveDatabasesReader {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;
    type Error = DatabaseError;

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
