//! The [`ServerRegistry`] port: the install's list of servers.

use crate::domain::{RegistryError, ServerRecord};

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

    /// Add `record`.
    ///
    /// # Errors
    ///
    /// [`RegistryError::AlreadyRegistered`] when a server with its domain is
    /// registered, or a read or write failure.
    fn insert(&self, record: ServerRecord) -> Result<(), RegistryError>;

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
