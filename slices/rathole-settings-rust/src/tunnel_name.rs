//! [`TunnelName`]: a tunnel's name at the relay, checked once.
//!
//! The name is a subdomain (`<tunnel name>.<domain>`), the tunnel's rathole
//! service name and, on the device, the folder its server keeps its data in,
//! so it is one lowercase DNS label ([`is_dns_label`]). [`ADMIN_KEY_ID`] is
//! the `keyid` the relay's operator signs with, so no tunnel may take it.
//! Both checks run on construction and on deserialisation, so a `TunnelName`
//! read from a file is as valid as one parsed from input.

use serde::{Deserialize, Serialize};

/// The `keyid` the relay's operator signs requests with, using
/// `WILDFLOWER_RELAY_ADMIN_KEY`. A tunnel signs with its own name as its
/// `keyid`, so no tunnel may be called this.
pub const ADMIN_KEY_ID: &str = "admin";

/// A lowercase LDH label: 1–63 of `[a-z0-9-]`, not starting or ending in `-`.
#[must_use]
pub fn is_dns_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// A tunnel's name: one lowercase DNS label, never [`ADMIN_KEY_ID`].
///
/// Serialises as the bare string, and deserialising runs the same checks as
/// [`parse`](TunnelName::parse).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TunnelName(String);

impl TunnelName {
    /// Check `name` and wrap it. It is taken as given: an uppercase name is
    /// refused rather than folded.
    ///
    /// # Errors
    ///
    /// [`InvalidTunnelName::NotDnsLabel`] when `name` isn't one lowercase DNS
    /// label, and [`InvalidTunnelName::Reserved`] when it is [`ADMIN_KEY_ID`].
    pub fn parse(name: impl Into<String>) -> Result<Self, InvalidTunnelName> {
        let name = name.into();
        if !is_dns_label(&name) {
            return Err(InvalidTunnelName::NotDnsLabel { name });
        }
        if name == ADMIN_KEY_ID {
            return Err(InvalidTunnelName::Reserved { name });
        }
        Ok(Self(name))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for TunnelName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for TunnelName {
    type Error = InvalidTunnelName;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        Self::parse(name)
    }
}

impl From<TunnelName> for String {
    fn from(tunnel_name: TunnelName) -> Self {
        tunnel_name.0
    }
}

/// Why a string isn't a [`TunnelName`]. Each names the string it refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidTunnelName {
    /// Not one lowercase DNS label.
    #[error("tunnel name {name:?} is not a lowercase DNS label")]
    NotDnsLabel { name: String },
    /// [`ADMIN_KEY_ID`], which the relay's operator signs as.
    #[error("tunnel name {name:?} is reserved")]
    Reserved { name: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lowercase_dns_labels() {
        for name in ["a", "abc123", "abc-123", "0", &"a".repeat(63)] {
            assert_eq!(TunnelName::parse(name).unwrap().as_str(), name);
        }
    }

    #[test]
    fn refuses_anything_but_one_lowercase_dns_label() {
        for name in [
            "",
            "Alice",
            "a.b",
            "-abc",
            "abc-",
            "a_b",
            "a b",
            "ü",
            &"a".repeat(64),
        ] {
            assert_eq!(
                TunnelName::parse(name),
                Err(InvalidTunnelName::NotDnsLabel {
                    name: name.to_owned()
                }),
                "{name:?}"
            );
        }
    }

    #[test]
    fn refuses_the_admin_key_id() {
        assert_eq!(
            TunnelName::parse(ADMIN_KEY_ID),
            Err(InvalidTunnelName::Reserved {
                name: ADMIN_KEY_ID.to_owned()
            })
        );
    }

    #[test]
    fn serialises_as_the_bare_name() {
        let tunnel_name = TunnelName::parse("ruth").unwrap();
        assert_eq!(serde_json::to_string(&tunnel_name).unwrap(), r#""ruth""#);
        assert_eq!(
            serde_json::from_str::<TunnelName>(r#""ruth""#).unwrap(),
            tunnel_name
        );
    }

    #[test]
    fn deserialising_runs_the_same_checks() {
        for json in [r#""Ruth""#, r#""a.b""#, r#""admin""#, r#""""#] {
            assert!(serde_json::from_str::<TunnelName>(json).is_err(), "{json}");
        }
    }
}
