//! [`DatabasesState`] — the router state: the host catalogue plus the concrete
//! [`FilesystemDatabaseFiles`] adapter, built once by [`crate::setup_databases`]
//! and handed in. It lives here in [`live_bindings`](super), not in `domain/`,
//! deliberately: it names the concrete adapter (which `domain/` must not), and the
//! sibling per-capability bindings clone it by value into each generic capability
//! at construction — so the scope-gated [`capabilities`](crate::domain::capabilities)
//! in `domain/` stay port-only and stubbable while the concrete wiring lives out
//! here.

use std::sync::Arc;

use crate::adapters::FilesystemDatabaseFiles;
use crate::config::DatabaseDescriptor;

/// Shared handler state: the catalogue of databases the host exposes plus the
/// concrete [`FilesystemDatabaseFiles`] adapter over the data directory. Cheap to
/// share behind an `Arc`. Opaque to callers outside the crate — the host receives
/// one from [`crate::setup_databases`] and never looks inside.
pub struct DatabasesState {
    catalogue: Arc<[DatabaseDescriptor]>,
    /// The filesystem adapter, cloned by value into each capability binding at
    /// construction (cheap — it only wraps the data-dir path).
    pub(crate) files: FilesystemDatabaseFiles,
}

impl DatabasesState {
    /// Build the state over the host catalogue and the [`FilesystemDatabaseFiles`]
    /// adapter [`crate::setup_databases`] constructs over the data directory.
    ///
    /// # Panics
    ///
    /// Panics if any catalogue id is not header-safe (see
    /// [`DatabaseDescriptor::has_header_safe_id`]). The id is used verbatim both
    /// as an on-disk filename and in the download handler's `Content-Disposition`
    /// header, so a malformed id is a host misconfiguration that must fail loudly
    /// at startup rather than surface as a corrupt header or a path escape. The
    /// catalogue is host-owned and build-time constant, so this fires only on a
    /// broken build, never on client input.
    #[must_use]
    pub(crate) fn new(databases: Vec<DatabaseDescriptor>, files: FilesystemDatabaseFiles) -> Self {
        for descriptor in &databases {
            assert!(
                descriptor.has_header_safe_id(),
                "database catalogue id {:?} is not header-safe: ids must be non-empty and \
                 ASCII alphanumeric plus '.', '-', '_' (used verbatim as a filename and in the \
                 download Content-Disposition header)",
                descriptor.id,
            );
        }
        Self {
            catalogue: databases.into(),
            files,
        }
    }

    /// The catalogue, in display order — the capabilities resolve ids and gate
    /// scopes against it.
    pub(crate) fn catalogue(&self) -> Arc<[DatabaseDescriptor]> {
        Arc::clone(&self.catalogue)
    }
}
