//! Shared handler state for the databases slice. Holds only the data directory;
//! everything else (which databases exist, where they live) derives from the
//! [`catalog`](crate::catalog).

use std::path::PathBuf;

use crate::catalog::{self, DatabaseDescriptor};

/// Handler state: the directory the host databases live in. Cheap to share
/// behind an `Arc`, mirroring `apps-rust`'s `AppsState`.
pub struct DatabasesState {
    data_dir: PathBuf,
}

impl DatabasesState {
    /// Build the state over the host's data directory.
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// Resolve a resource id to its catalogue descriptor, rejecting unknown
    /// ids. This is the only way an id becomes a path, so an id that isn't in
    /// the catalogue can never reach the filesystem (path-traversal guard).
    pub(crate) fn descriptor(&self, id: &str) -> Option<&'static DatabaseDescriptor> {
        catalog::descriptor(id)
    }

    /// The on-disk path for a catalogued database. Built from the fixed
    /// catalogue filename, never from raw client input.
    pub(crate) fn path_for(&self, descriptor: &DatabaseDescriptor) -> PathBuf {
        self.data_dir.join(descriptor.id)
    }
}
