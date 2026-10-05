//! [`EnrolmentError`]: how adding a server, or re-entering its credentials,
//! fails.
//!
//! No variant holds the tunnel's token, and none of the errors a variant
//! wraps was given it, so an error can be logged or shown as it is.
//!
//! `Serialize` writes `{"kind": "<kind>", "message": "<Display>"}`, the shape
//! the base's commands answer a failure with; [`EnrolmentError::kind`] lists
//! the kinds.

use rathole_settings_rust::{InvalidTunnelName, TunnelName};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use url::Url;

use crate::domain::RegistryError;

/// The ways enrolling with a relay fails.
#[derive(Debug, thiserror::Error)]
pub enum EnrolmentError {
    /// The entered tunnel name isn't one lowercase DNS label, or is reserved.
    #[error(transparent)]
    InvalidTunnelName(#[from] InvalidTunnelName),
    /// No response came back from the relay's site: it couldn't be
    /// connected to, its TLS failed, or it didn't answer in time.
    #[error("the relay at {relay_base} couldn't be reached: {source}")]
    RelayUnreachable {
        relay_base: Url,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    /// The relay answered `path` with something other than what a Wildflower
    /// relay serves there.
    #[error("the relay's {path} response was unusable: {reason}")]
    BadRelayResponse { path: &'static str, reason: String },
    /// The relay's `GET /rathole` disagrees with a setting the user pinned.
    #[error("the relay serves {setting} {served:?}, not the pinned {pinned:?}")]
    PinMismatch {
        setting: &'static str,
        pinned: String,
        served: String,
    },
    /// The relay refused the signed `GET /me`: it has no tunnel with this
    /// name, or the token isn't that tunnel's.
    #[error("the relay rejected the tunnel name {tunnel_name} or its token")]
    CredentialsRejected { tunnel_name: TunnelName },
    /// The relay now serves a different domain than the server was added
    /// under, so the server's domain, its identity, would change.
    #[error("the relay now serves the domain {served}, not {registered}")]
    DomainChanged { registered: String, served: String },
    /// Reading or writing the registry failed, including
    /// [`RegistryError::AlreadyRegistered`] for a server that already exists
    /// and [`RegistryError::NotRegistered`] for one that doesn't.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

impl EnrolmentError {
    /// What went wrong, as a stable `snake_case` name a caller can branch on:
    /// one per variant, except that [`EnrolmentError::Registry`] is
    /// `already_registered`, `not_registered` or, for a registry that can't
    /// be read or written, `registry`.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidTunnelName(_) => "invalid_tunnel_name",
            Self::RelayUnreachable { .. } => "relay_unreachable",
            Self::BadRelayResponse { .. } => "bad_relay_response",
            Self::PinMismatch { .. } => "pin_mismatch",
            Self::CredentialsRejected { .. } => "credentials_rejected",
            Self::DomainChanged { .. } => "domain_changed",
            Self::Registry(RegistryError::AlreadyRegistered { .. }) => "already_registered",
            Self::Registry(RegistryError::NotRegistered { .. }) => "not_registered",
            Self::Registry(
                RegistryError::UnsupportedVersion { .. } | RegistryError::Storage { .. },
            ) => "registry",
        }
    }
}

impl Serialize for EnrolmentError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("EnrolmentError", 2)?;
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
        let tunnel_name = TunnelName::parse("ruth").unwrap();
        for (error, kind) in [
            (
                EnrolmentError::from(TunnelName::parse("Ruth").unwrap_err()),
                "invalid_tunnel_name",
            ),
            (
                EnrolmentError::RelayUnreachable {
                    relay_base: Url::parse("https://relay.example.com").unwrap(),
                    source: "connection refused".into(),
                },
                "relay_unreachable",
            ),
            (
                EnrolmentError::BadRelayResponse {
                    path: "/rathole",
                    reason: "status 404 Not Found".to_owned(),
                },
                "bad_relay_response",
            ),
            (
                EnrolmentError::PinMismatch {
                    setting: "public_key",
                    pinned: "a".to_owned(),
                    served: "b".to_owned(),
                },
                "pin_mismatch",
            ),
            (
                EnrolmentError::CredentialsRejected {
                    tunnel_name: tunnel_name.clone(),
                },
                "credentials_rejected",
            ),
            (
                EnrolmentError::DomainChanged {
                    registered: "old.example.com".to_owned(),
                    served: "relay.example.com".to_owned(),
                },
                "domain_changed",
            ),
            (
                RegistryError::AlreadyRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }
                .into(),
                "already_registered",
            ),
            (
                RegistryError::NotRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }
                .into(),
                "not_registered",
            ),
            (
                RegistryError::UnsupportedVersion { version: 2 }.into(),
                "registry",
            ),
            (
                RegistryError::storage("reading servers.json", "permission denied").into(),
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
