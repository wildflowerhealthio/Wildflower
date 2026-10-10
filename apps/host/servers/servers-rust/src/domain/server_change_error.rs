//! [`ServerChangeError`]: how changing a registered server fails, through
//! [`set_run_policy`](crate::set_run_policy), [`update_server`](crate::update_server)
//! or [`remove_server`](crate::remove_server).
//!
//! `Serialize` writes `{"kind": "<kind>", "message": "<Display>"}`, the shape
//! the base's commands answer a failure with; [`ServerChangeError::kind`]
//! lists the kinds.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::domain::RegistryError;

/// The ways changing a registered server fails.
#[derive(Debug, thiserror::Error)]
pub enum ServerChangeError {
    /// A run-for duration of zero seconds or less.
    #[error("a server can't be run for {seconds} seconds: the duration must be more than zero")]
    NonPositiveDuration { seconds: i64 },
    /// A run-for duration whose deadline is later than a policy can hold.
    #[error("a server can't be run for {seconds} seconds: the deadline is out of range")]
    DurationOutOfRange { seconds: i64 },
    /// The entered launcher URL isn't one the base can open apps from.
    #[error("the entered launcher URL {reason}")]
    InvalidLauncherUrl { reason: String },
    /// The removed server's folder couldn't be deleted. The server is still
    /// registered.
    #[error("the folder of {domain} couldn't be deleted: {source}")]
    DeletingFolder {
        domain: String,
        #[source]
        source: std::io::Error,
    },
    /// Reading or writing the registry failed, including
    /// [`RegistryError::NotRegistered`] for a server that isn't registered.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

impl ServerChangeError {
    /// What went wrong, as a stable `camelCase` name a caller can branch on:
    /// one per variant, except that [`ServerChangeError::Registry`] is its
    /// [`RegistryError::kind`].
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NonPositiveDuration { .. } => "nonPositiveDuration",
            Self::DurationOutOfRange { .. } => "durationOutOfRange",
            Self::InvalidLauncherUrl { .. } => "invalidLauncherUrl",
            Self::DeletingFolder { .. } => "deletingFolder",
            Self::Registry(registry_error) => registry_error.kind(),
        }
    }
}

impl Serialize for ServerChangeError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("ServerChangeError", 2)?;
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
                ServerChangeError::NonPositiveDuration { seconds: 0 },
                "nonPositiveDuration",
            ),
            (
                ServerChangeError::InvalidLauncherUrl {
                    reason: "\"ftp://x\" is not an http or https URL".to_owned(),
                },
                "invalidLauncherUrl",
            ),
            (
                ServerChangeError::Registry(RegistryError::NotRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }),
                "notRegistered",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({"kind": kind, "message": error.to_string()})
            );
        }
    }
}
