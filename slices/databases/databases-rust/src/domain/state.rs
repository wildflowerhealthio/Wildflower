//! [`DatabasesState`] — the state the router carries and the capabilities are
//! built from. A pure `domain/` value: the host-supplied catalogue plus a
//! [`DatabaseFiles`] port handle (never a concrete filesystem or `crate::http`
//! type), so the whole domain is runnable in tests with a stub port. The real
//! `FilesystemDatabaseFiles` is injected by `crate::setup_databases`.

use std::sync::Arc;

use crate::config::DatabaseDescriptor;
use crate::domain::DatabaseFiles;

/// Shared handler state: the catalogue of databases the host exposes plus the
/// [`DatabaseFiles`] port the capabilities operate through. Cheap to share behind
/// an `Arc`. Opaque to callers outside the crate — the host receives one from
/// [`crate::setup_databases`] and never looks inside.
pub struct DatabasesState {
    catalogue: Arc<[DatabaseDescriptor]>,
    files: Arc<dyn DatabaseFiles>,
}

impl DatabasesState {
    /// Build the state over the host catalogue and a [`DatabaseFiles`] port.
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
    pub(crate) fn with_files(
        databases: Vec<DatabaseDescriptor>,
        files: Arc<dyn DatabaseFiles>,
    ) -> Self {
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

    /// The [`DatabaseFiles`] port handle a capability lifts at construction.
    pub(crate) fn files(&self) -> Arc<dyn DatabaseFiles> {
        Arc::clone(&self.files)
    }
}
