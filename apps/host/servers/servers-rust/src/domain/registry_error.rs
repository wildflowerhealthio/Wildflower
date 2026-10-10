//! [`RegistryError`]: how a [`ServerRegistry`](crate::ServerRegistry)
//! operation fails.
//!
//! `Serialize` writes `{"kind": "<kind>", "message": "<Display>"}`, the shape
//! the base's commands answer a failure with; [`RegistryError::kind`] lists
//! the kinds.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// The ways reading or changing the registry fails.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    /// An insert named a domain the registry already holds.
    #[error("a server with the domain {domain} is already registered")]
    AlreadyRegistered { domain: String },
    /// A change or remove named a domain the registry doesn't hold.
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
    /// What went wrong, as a stable `camelCase` name a caller can branch on:
    /// `alreadyRegistered`, `notRegistered`, or `registry` for a registry
    /// that can't be read or written.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::AlreadyRegistered { .. } => "alreadyRegistered",
            Self::NotRegistered { .. } => "notRegistered",
            Self::UnsupportedVersion { .. } | Self::Storage { .. } => "registry",
        }
    }

    /// No server with `domain` is registered.
    #[must_use]
    pub fn not_registered(domain: &str) -> Self {
        Self::NotRegistered {
            domain: domain.to_owned(),
        }
    }

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

impl Serialize for RegistryError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("RegistryError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_its_kind_and_message() {
        for (error, kind) in [
            (
                RegistryError::NotRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                },
                "notRegistered",
            ),
            (
                RegistryError::AlreadyRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                },
                "alreadyRegistered",
            ),
            (RegistryError::UnsupportedVersion { version: 3 }, "registry"),
            (
                RegistryError::storage("reading servers.json", "disk on fire"),
                "registry",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({"kind": kind, "message": error.to_string()})
            );
        }
    }
}
