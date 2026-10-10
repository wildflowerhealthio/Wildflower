//! [`LaunchError`], why a server's launcher couldn't be opened.

use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::domain::{CertificateAuthority, RegistryError};

/// Why a server's launcher couldn't be opened. Serialises as
/// `{"kind", "message"}`.
#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    /// The server isn't running, so it has no launch to hand out.
    #[error("the server {domain} isn't running")]
    ServerNotRunning { domain: String },
    /// The server is running, but its `/health` hasn't been asked through
    /// its relay yet.
    #[error("the server {domain} hasn't been reached through its relay yet")]
    NotYetProbed { domain: String },
    /// The server's `/health` didn't answer through its relay.
    #[error("the server {domain} can't be reached through its relay: {error}")]
    Unreachable { domain: String, error: String },
    /// The server's certificate isn't valid: none is issued yet, it is
    /// being ordered, its orders are failing, it has expired, or its cache
    /// can't be read.
    #[error("the server {domain} has no valid certificate")]
    NoValidCertificate { domain: String },
    /// The server's certificate is valid, but from a CA browsers don't
    /// trust, so an app's browser would refuse it.
    #[error(
        "the server {domain}'s certificate is from {}, which browsers don't trust",
        issuer.name()
    )]
    UntrustedCertificate {
        domain: String,
        issuer: CertificateAuthority,
    },
    /// The server's gatekeeper couldn't mint the launch.
    #[error("the server's gatekeeper failed: {0}")]
    Gatekeeper(#[from] GatekeeperError),
    /// The launcher's window couldn't be opened.
    #[error("the launcher couldn't be opened: {reason}")]
    OpeningLauncher { reason: String },
    /// Reading the registry failed, including
    /// [`RegistryError::NotRegistered`] for a server that isn't registered.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

impl LaunchError {
    /// The camelCase name the base branches on: one per variant, except that
    /// [`LaunchError::Registry`] is its [`RegistryError::kind`].
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ServerNotRunning { .. } => "serverNotRunning",
            Self::NotYetProbed { .. } => "notYetProbed",
            Self::Unreachable { .. } => "unreachable",
            Self::NoValidCertificate { .. } => "noValidCertificate",
            Self::UntrustedCertificate { .. } => "untrustedCertificate",
            Self::Gatekeeper(_) => "gatekeeper",
            Self::OpeningLauncher { .. } => "openingLauncher",
            Self::Registry(registry_error) => registry_error.kind(),
        }
    }
}

impl Serialize for LaunchError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("LaunchError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::golden;

    const DOMAIN: &str = "ruth.relay.example.com";

    #[test]
    fn serialises_as_its_kind_and_message() {
        for (error, kind) in [
            (
                LaunchError::ServerNotRunning {
                    domain: DOMAIN.to_owned(),
                },
                "serverNotRunning",
            ),
            (
                LaunchError::NotYetProbed {
                    domain: DOMAIN.to_owned(),
                },
                "notYetProbed",
            ),
            (
                LaunchError::Unreachable {
                    domain: DOMAIN.to_owned(),
                    error: "connection refused".to_owned(),
                },
                "unreachable",
            ),
            (
                LaunchError::NoValidCertificate {
                    domain: DOMAIN.to_owned(),
                },
                "noValidCertificate",
            ),
            (
                LaunchError::UntrustedCertificate {
                    domain: DOMAIN.to_owned(),
                    issuer: CertificateAuthority::LetsEncryptStaging,
                },
                "untrustedCertificate",
            ),
            (
                LaunchError::Gatekeeper(GatekeeperError::infrastructure(
                    "minting a launch",
                    "the database is locked",
                )),
                "gatekeeper",
            ),
            (
                LaunchError::OpeningLauncher {
                    reason: "no window".to_owned(),
                },
                "openingLauncher",
            ),
            (
                LaunchError::Registry(RegistryError::NotRegistered {
                    domain: DOMAIN.to_owned(),
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

    #[test]
    fn the_refusals_the_base_shows_are_as_the_golden_file_says() {
        let errors = [
            LaunchError::ServerNotRunning {
                domain: DOMAIN.to_owned(),
            },
            LaunchError::NotYetProbed {
                domain: DOMAIN.to_owned(),
            },
            LaunchError::Unreachable {
                domain: DOMAIN.to_owned(),
                error: "the relay answered 502".to_owned(),
            },
            LaunchError::NoValidCertificate {
                domain: DOMAIN.to_owned(),
            },
            LaunchError::Registry(RegistryError::NotRegistered {
                domain: DOMAIN.to_owned(),
            }),
            LaunchError::UntrustedCertificate {
                domain: DOMAIN.to_owned(),
                issuer: CertificateAuthority::LetsEncryptStaging,
            },
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden()["launchErrors"]
        );
    }
}
