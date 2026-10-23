//! [`EnrolmentError`]: how adding a server, or re-entering its credentials,
//! fails.
//!
//! No variant holds the tunnel's token or a claim code, and none of the
//! errors a variant wraps was given either, so an error can be logged or
//! shown as it is.
//!
//! `Serialize` writes `{"kind": "<kind>", "message": "<Display>"}`, the shape
//! the base's commands answer a failure with; [`EnrolmentError::kind`] lists
//! the kinds.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use url::Url;
use wildflowerhealthio_rathole_settings::{InvalidTunnelName, TunnelName};

use crate::domain::RegistryError;

/// The ways enrolling with a relay fails.
#[derive(Debug, thiserror::Error)]
pub enum EnrolmentError {
    /// The entered tunnel name isn't one lowercase DNS label, or is reserved.
    #[error(transparent)]
    InvalidTunnelName(#[from] InvalidTunnelName),
    /// The entered token is empty once its surrounding whitespace is trimmed.
    #[error("the tunnel token is empty")]
    EmptyToken,
    /// The entered claim code is empty once its surrounding whitespace is
    /// trimmed.
    #[error("the claim code is empty")]
    EmptyClaimCode,
    /// The email entered with an access code is empty once its surrounding
    /// whitespace is trimmed.
    #[error("the email is empty")]
    EmptyEmail,
    /// A claim code was entered for a relay that doesn't redeem them: a
    /// [`RelayKind::Rathole`](crate::RelayKind::Rathole) relay, which has no
    /// Wildflower relay site, or a Wildflower relay whose site answers
    /// `POST /claim` with `404`, as one run without its admin API does.
    #[error(
        "this relay doesn't take claim codes: enter the tunnel name and token you were given \
         instead"
    )]
    ClaimCodesNotOffered,
    /// The relay answered `POST /claim` with `422`, which it does for every
    /// code it won't redeem, whatever the reason: one it never issued, one
    /// already redeemed, one that has expired or been replaced, or one that
    /// isn't a code at all.
    #[error("that claim code is unknown, used or expired: ask your relay's admin for a new one")]
    ClaimCodeRejected,
    /// The relay answered `POST /claim` with `429`: too many claim attempts,
    /// from this device or overall, in too short a time.
    #[error("the relay has had too many claim attempts: try again in a few minutes")]
    ClaimRateLimited,
    /// The relay answered `POST /claim` with `409`: the code is an access
    /// code, which it hasn't burned. It redeems at `POST /access` for a new
    /// tunnel, so the user enters an email and, optionally, a subdomain, and
    /// adds the server with them
    /// ([`EnteredCredentials::AccessCode`](crate::EnteredCredentials::AccessCode)).
    #[error("that code is an access code: enter your email and choose a subdomain")]
    AccessCodeNeedsDetails,
    /// The relay refused `POST /access` with `422`, `409` or `503`: the
    /// access code is unknown, used or expired, or, for a code that would
    /// redeem, the email or subdomain is unusable, reserved or taken, or no
    /// subdomain is left to draw. `reason` is the relay's own plain-text
    /// answer, which says which.
    #[error("the relay refused the access code: {reason}")]
    AccessRefused { reason: String },
    /// A relay setting entered by hand is one a server can't be built on: a
    /// self-hosted relay's `baseUrl`, or a
    /// [`RelayKind::Rathole`](crate::RelayKind::Rathole) relay's
    /// `remoteAddr`, `publicKey` or `domain`. `setting` names it as the
    /// command's arguments do.
    #[error("the entered {setting} {reason}")]
    InvalidRelaySetting {
        setting: &'static str,
        reason: String,
    },
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
    /// The relay answered the `GET /me` signed as `tunnel_name` with `401`.
    /// The relay gives one bare `401` for every signature it refuses, so this
    /// could be an unknown tunnel name, a token that isn't that tunnel's, a
    /// device clock more than a minute off the relay's, or a replayed or
    /// malformed signature.
    #[error(
        "the relay rejected the request signed as tunnel {tunnel_name}: check the tunnel \
         name and token, and that this device's clock is set correctly"
    )]
    SignedRequestRejected { tunnel_name: TunnelName },
    /// The relay now serves a different domain than the server was added
    /// under, so the server's domain, its identity, would change.
    #[error("the relay now serves the domain {served}, not {registered}")]
    DomainChanged { registered: String, served: String },
    /// The relay's identity has changed since the server was added: its
    /// `GET /rathole` now serves another `remoteAddr` or `publicKey` than
    /// the server was added with. It may have been re-keyed or moved, or
    /// someone may be impersonating it, so nothing is written and the UI
    /// should warn about it rather than offer a retry.
    #[error(
        "WARNING: the relay's identity has changed. It now presents {setting} {served:?}, \
         not the {registered:?} it had when this server was added. The relay may have \
         been re-keyed, or someone may be impersonating it. Nothing was changed."
    )]
    RelayIdentityChanged {
        setting: &'static str,
        registered: String,
        served: String,
    },
    /// Reading or writing the registry failed, including
    /// [`RegistryError::AlreadyRegistered`] for a server that already exists
    /// and [`RegistryError::NotRegistered`] for one that doesn't.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

impl EnrolmentError {
    /// What went wrong, as a stable `camelCase` name a caller can branch on:
    /// one per variant, except that [`EnrolmentError::Registry`] is its
    /// [`RegistryError::kind`].
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::InvalidTunnelName(_) => "invalidTunnelName",
            Self::EmptyToken => "emptyToken",
            Self::EmptyClaimCode => "emptyClaimCode",
            Self::EmptyEmail => "emptyEmail",
            Self::ClaimCodesNotOffered => "claimCodesNotOffered",
            Self::ClaimCodeRejected => "claimCodeRejected",
            Self::ClaimRateLimited => "claimRateLimited",
            Self::AccessCodeNeedsDetails => "accessCodeNeedsDetails",
            Self::AccessRefused { .. } => "accessRefused",
            Self::InvalidRelaySetting { .. } => "invalidRelaySetting",
            Self::RelayUnreachable { .. } => "relayUnreachable",
            Self::BadRelayResponse { .. } => "badRelayResponse",
            Self::PinMismatch { .. } => "pinMismatch",
            Self::SignedRequestRejected { .. } => "signedRequestRejected",
            Self::DomainChanged { .. } => "domainChanged",
            Self::RelayIdentityChanged { .. } => "relayIdentityChanged",
            Self::Registry(registry_error) => registry_error.kind(),
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
    fn a_rejected_signature_suggests_the_token_and_the_clock() {
        let message = EnrolmentError::SignedRequestRejected {
            tunnel_name: TunnelName::parse("ruth").unwrap(),
        }
        .to_string();
        assert_eq!(
            message,
            "the relay rejected the request signed as tunnel ruth: check the tunnel name and \
             token, and that this device's clock is set correctly"
        );
    }

    #[test]
    fn an_identity_change_is_a_plain_warning() {
        let message = EnrolmentError::RelayIdentityChanged {
            setting: "publicKey",
            registered: "old-key".to_owned(),
            served: "new-key".to_owned(),
        }
        .to_string();
        assert!(
            message.starts_with("WARNING: the relay's identity has changed."),
            "{message}"
        );
        assert!(
            message.contains(r#"publicKey "new-key", not the "old-key""#),
            "{message}"
        );
        assert!(message.contains("impersonating"), "{message}");
        assert!(message.ends_with("Nothing was changed."), "{message}");
    }

    #[test]
    fn serialises_as_its_kind_and_message() {
        let tunnel_name = TunnelName::parse("ruth").unwrap();
        for (error, kind) in [
            (
                EnrolmentError::from(TunnelName::parse("Ruth").unwrap_err()),
                "invalidTunnelName",
            ),
            (EnrolmentError::EmptyToken, "emptyToken"),
            (EnrolmentError::EmptyClaimCode, "emptyClaimCode"),
            (EnrolmentError::ClaimCodesNotOffered, "claimCodesNotOffered"),
            (EnrolmentError::ClaimCodeRejected, "claimCodeRejected"),
            (EnrolmentError::ClaimRateLimited, "claimRateLimited"),
            (EnrolmentError::EmptyEmail, "emptyEmail"),
            (
                EnrolmentError::AccessCodeNeedsDetails,
                "accessCodeNeedsDetails",
            ),
            (
                EnrolmentError::AccessRefused {
                    reason: "a tunnel already has the name".to_owned(),
                },
                "accessRefused",
            ),
            (
                EnrolmentError::InvalidRelaySetting {
                    setting: "remoteAddr",
                    reason: "\"relay\" is not host:port".to_owned(),
                },
                "invalidRelaySetting",
            ),
            (
                EnrolmentError::RelayUnreachable {
                    relay_base: Url::parse("https://relay.example.com").unwrap(),
                    source: "connection refused".into(),
                },
                "relayUnreachable",
            ),
            (
                EnrolmentError::BadRelayResponse {
                    path: "/rathole",
                    reason: "status 404 Not Found".to_owned(),
                },
                "badRelayResponse",
            ),
            (
                EnrolmentError::PinMismatch {
                    setting: "publicKey",
                    pinned: "a".to_owned(),
                    served: "b".to_owned(),
                },
                "pinMismatch",
            ),
            (
                EnrolmentError::SignedRequestRejected {
                    tunnel_name: tunnel_name.clone(),
                },
                "signedRequestRejected",
            ),
            (
                EnrolmentError::DomainChanged {
                    registered: "old.example.com".to_owned(),
                    served: "relay.example.com".to_owned(),
                },
                "domainChanged",
            ),
            (
                EnrolmentError::RelayIdentityChanged {
                    setting: "publicKey",
                    registered: "a".to_owned(),
                    served: "b".to_owned(),
                },
                "relayIdentityChanged",
            ),
            (
                RegistryError::AlreadyRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }
                .into(),
                "alreadyRegistered",
            ),
            (
                RegistryError::NotRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }
                .into(),
                "notRegistered",
            ),
            (
                RegistryError::UnsupportedVersion { version: 3 }.into(),
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

    /// The errors the base shows when adding a server, or re-entering a
    /// token, fails are the ones the golden file holds.
    #[test]
    fn the_enrolment_errors_are_as_the_golden_file_says() {
        let golden = crate::domain::golden();
        let errors = [
            (
                "invalidRelaySetting",
                EnrolmentError::InvalidRelaySetting {
                    setting: "baseUrl",
                    reason: r#""http://relay.example.com" is not an https URL"#.to_owned(),
                },
            ),
            (
                "relayUnreachable",
                EnrolmentError::RelayUnreachable {
                    relay_base: Url::parse("https://relay.example.com").unwrap(),
                    source: "connection refused".into(),
                },
            ),
            (
                "badRelayResponse",
                EnrolmentError::BadRelayResponse {
                    path: "/rathole",
                    reason: "status 404 Not Found".to_owned(),
                },
            ),
            (
                "pinMismatch",
                EnrolmentError::PinMismatch {
                    setting: "remoteAddr",
                    pinned: "relay.example.com:2333".to_owned(),
                    served: "relay.example.com:2334".to_owned(),
                },
            ),
            (
                "invalidTunnelName",
                TunnelName::parse("Ruth").unwrap_err().into(),
            ),
            ("emptyToken", EnrolmentError::EmptyToken),
            ("emptyClaimCode", EnrolmentError::EmptyClaimCode),
            ("claimCodesNotOffered", EnrolmentError::ClaimCodesNotOffered),
            ("claimCodeRejected", EnrolmentError::ClaimCodeRejected),
            ("claimRateLimited", EnrolmentError::ClaimRateLimited),
            ("emptyEmail", EnrolmentError::EmptyEmail),
            (
                "accessCodeNeedsDetails",
                EnrolmentError::AccessCodeNeedsDetails,
            ),
            (
                "accessRefused",
                EnrolmentError::AccessRefused {
                    reason: "a tunnel already has the name".to_owned(),
                },
            ),
            (
                "signedRequestRejected",
                EnrolmentError::SignedRequestRejected {
                    tunnel_name: TunnelName::parse("ruth").unwrap(),
                },
            ),
            (
                "alreadyRegistered",
                RegistryError::AlreadyRegistered {
                    domain: "ruth.relay.example.com".to_owned(),
                }
                .into(),
            ),
            (
                "relayIdentityChanged",
                EnrolmentError::RelayIdentityChanged {
                    setting: "publicKey",
                    registered: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
                    served: "Ny0NYH8cmCUs1ZpKr9ezG2UKq1z8f9UWRUXvJ7Ql1yI=".to_owned(),
                },
            ),
        ];
        for (name, error) in &errors {
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                golden["enrolmentErrors"][name],
                "{name}"
            );
        }
        assert_eq!(
            golden["enrolmentErrors"].as_object().unwrap().len(),
            errors.len(),
            "every golden enrolment error is checked"
        );
    }
}
