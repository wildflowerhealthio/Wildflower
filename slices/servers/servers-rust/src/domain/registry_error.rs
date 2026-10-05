//! [`RegistryError`]: how a [`ServerRegistry`](crate::ServerRegistry)
//! operation fails.

/// The ways reading or changing the registry fails.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    /// An insert named a domain the registry already holds.
    #[error("a server with the domain {domain} is already registered")]
    AlreadyRegistered { domain: String },
    /// An update or remove named a domain the registry doesn't hold.
    #[error("no server with the domain {domain} is registered")]
    NotRegistered { domain: String },
    /// The stored registry is in a format version this build doesn't read.
    /// Nothing is read from it, and nothing is written over it.
    #[error("the server registry has format version {version}, which this build doesn't read")]
    UnsupportedVersion { version: u64 },
    /// The stored registry couldn't be read, parsed or replaced.
    #[error("{context}: {source}")]
    Storage {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

impl RegistryError {
    /// Wrap a storage failure with what was being done when it happened.
    #[must_use]
    pub fn storage(
        context: &'static str,
        source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
    ) -> Self {
        Self::Storage {
            context,
            source: source.into(),
        }
    }
}
