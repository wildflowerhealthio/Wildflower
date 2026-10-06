//! The [`ServerRegistry`] port: the install's list of servers.

use crate::domain::{RegistryError, ServerRecord};

/// Builds the record [`ServerRegistry::insert`] adds, from the servers already
/// registered.
pub type NewRecord<'a> = Box<dyn FnOnce(&[ServerRecord]) -> ServerRecord + 'a>;

/// The servers this install knows about, keyed by
/// [`ServerRecord::domain`]. The production adapter is
/// [`JsonServerRegistry`](crate::JsonServerRegistry).
///
/// Synchronous: the registry is one small file. An async caller runs these on
/// a blocking thread.
pub trait ServerRegistry: Send + Sync {
    /// Every registered server, in the order they were added.
    ///
    /// # Errors
    ///
    /// [`RegistryError::UnsupportedVersion`] or [`RegistryError::Storage`]
    /// when the stored registry can't be read.
    fn read_all(&self) -> Result<Vec<ServerRecord>, RegistryError>;

    /// Add the record `new_record` builds from the servers already registered,
    /// and return it. Reading those servers and adding the record are one
    /// change, so no other change lands between them.
    ///
    /// # Errors
    ///
    /// [`RegistryError::AlreadyRegistered`] when a server with the new
    /// record's domain is registered, or a read or write failure.
    fn insert(&self, new_record: NewRecord<'_>) -> Result<ServerRecord, RegistryError>;

    /// Replace the registered server with `record`'s domain by `record`.
    ///
    /// # Errors
    ///
    /// [`RegistryError::NotRegistered`] when no server has its domain, or a
    /// read or write failure.
    fn update(&self, record: ServerRecord) -> Result<(), RegistryError>;

    /// Remove the server with `domain`.
    ///
    /// # Errors
    ///
    /// [`RegistryError::NotRegistered`] when no server has `domain`, or a read
    /// or write failure.
    fn remove(&self, domain: &str) -> Result<(), RegistryError>;
}
