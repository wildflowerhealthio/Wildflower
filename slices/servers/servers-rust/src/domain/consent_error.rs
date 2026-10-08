//! [`ConsentError`], why a consent couldn't be read or decided.

use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Why a consent couldn't be read or decided. Serialises as
/// `{"kind", "message"}`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConsentError {
    /// The server isn't running, so its consents can't be reached.
    #[error("the server {domain} isn't running")]
    ServerNotRunning { domain: String },
    /// No consent with that key is waiting: it was answered elsewhere or
    /// expired.
    #[error("the request is no longer waiting: it was answered elsewhere or expired")]
    NotPending,
    /// The app is new to the server, or asks for more than it registered,
    /// and the approval didn't acknowledge it.
    #[error("the app is new or asks for more than it registered, so approving it needs that acknowledged")]
    RegistrationNotAcknowledged,
    /// Any other failure of the server's gatekeeper.
    #[error("the server's gatekeeper failed: {0}")]
    Gatekeeper(GatekeeperError),
}

impl ConsentError {
    /// The camelCase name the base branches on.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ServerNotRunning { .. } => "serverNotRunning",
            Self::NotPending => "notPending",
            Self::RegistrationNotAcknowledged => "registrationNotAcknowledged",
            Self::Gatekeeper(_) => "gatekeeper",
        }
    }
}

impl From<GatekeeperError> for ConsentError {
    fn from(error: GatekeeperError) -> Self {
        match error {
            GatekeeperError::DeviceConsentNotFound { .. }
            | GatekeeperError::OAuthConsentNotFound { .. } => Self::NotPending,
            GatekeeperError::RegistrationNotAcknowledged { .. } => {
                Self::RegistrationNotAcknowledged
            }
            other => Self::Gatekeeper(other),
        }
    }
}

impl Serialize for ConsentError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("ConsentError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gatekeeper_errors_the_base_branches_on_get_their_own_kind() {
        let cases = [
            (
                GatekeeperError::DeviceConsentNotFound {
                    user_code: "ABCD-EFGH".to_owned(),
                },
                "notPending",
            ),
            (
                GatekeeperError::OAuthConsentNotFound {
                    id: "req-1".to_owned(),
                },
                "notPending",
            ),
            (
                GatekeeperError::RegistrationNotAcknowledged {
                    id: "req-1".to_owned(),
                },
                "registrationNotAcknowledged",
            ),
            (
                GatekeeperError::infrastructure("reading a consent", "the database is locked"),
                "gatekeeper",
            ),
        ];
        for (gatekeeper_error, kind) in cases {
            assert_eq!(ConsentError::from(gatekeeper_error).kind(), kind);
        }
    }
}
