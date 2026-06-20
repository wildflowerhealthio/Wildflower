//! Shared handler state for the databases slice. Holds the data directory and
//! the host-supplied catalogue of databases to expose; the slice has no built-in
//! knowledge of which databases exist.

use std::path::PathBuf;

use crate::config::DatabaseDescriptor;

/// Handler state: the data directory plus the catalogue of databases the host
/// asked us to expose. Cheap to share behind an `Arc`, mirroring `apps-rust`'s
/// `AppsState`.
pub struct DatabasesState {
    data_dir: PathBuf,
    databases: Vec<DatabaseDescriptor>,
}

impl DatabasesState {
    /// Build the state over the host's data directory and database catalogue.
    pub(crate) fn new(data_dir: PathBuf, databases: Vec<DatabaseDescriptor>) -> Self {
        Self {
            data_dir,
            databases,
        }
    }

    /// The catalogue, in display order — drives `GET /databases`.
    pub(crate) fn databases(&self) -> &[DatabaseDescriptor] {
        &self.databases
    }

    /// Resolve a resource id to its descriptor, rejecting unknown ids. This is
    /// the only way an id becomes a path, so an id absent from the host
    /// catalogue can never reach the filesystem (path-traversal guard).
    pub(crate) fn descriptor(&self, id: &str) -> Option<&DatabaseDescriptor> {
        self.databases.iter().find(|descriptor| descriptor.id == id)
    }

    /// The on-disk path for a catalogued database. Built from the host-supplied
    /// catalogue filename, never from raw client input.
    pub(crate) fn path_for(&self, descriptor: &DatabaseDescriptor) -> PathBuf {
        self.data_dir.join(&descriptor.id)
    }
}
