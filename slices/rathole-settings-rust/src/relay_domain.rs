//! [`RelayDomain`]: the domain a relay serves its tunnels under, checked
//! once.
//!
//! A server's domain is `<tunnel name>.<relay domain>`, and on the device it
//! is also the name of the server's data folder, so the relay domain is a
//! lowercase DNS name ([`is_dns_name`]): no slash, no `..`, nothing a path
//! could escape through. The check runs on construction and on
//! deserialisation.

use serde::{Deserialize, Serialize};

use crate::is_dns_label;

/// Lowercase DNS labels ([`is_dns_label`]) joined by single dots: no empty
/// label, so no leading, trailing or doubled dot.
#[must_use]
pub fn is_dns_name(name: &str) -> bool {
    name.split('.').all(is_dns_label)
}

/// A relay's domain: a lowercase DNS name.
///
/// Serialises as the bare string, and deserialising runs the same check as
/// [`parse`](RelayDomain::parse).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelayDomain(String);

impl RelayDomain {
    /// Check `domain` and wrap it. It is taken as given: an uppercase domain
    /// is refused rather than folded.
    ///
    /// # Errors
    ///
    /// [`InvalidRelayDomain`] when `domain` isn't a lowercase DNS name.
    pub fn parse(domain: impl Into<String>) -> Result<Self, InvalidRelayDomain> {
        let domain = domain.into();
        if !is_dns_name(&domain) {
            return Err(InvalidRelayDomain { domain });
        }
        Ok(Self(domain))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for RelayDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for RelayDomain {
    type Error = InvalidRelayDomain;

    fn try_from(domain: String) -> Result<Self, Self::Error> {
        Self::parse(domain)
    }
}

impl From<RelayDomain> for String {
    fn from(domain: RelayDomain) -> Self {
        domain.0
    }
}

/// Why a string isn't a [`RelayDomain`], naming the string it refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("relay domain {domain:?} is not a lowercase DNS name")]
pub struct InvalidRelayDomain {
    pub domain: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lowercase_dns_names() {
        for domain in ["relay.example.com", "localhost", "a-1.b2.c", "10.0.0.1"] {
            assert_eq!(RelayDomain::parse(domain).unwrap().as_str(), domain);
        }
    }

    #[test]
    fn refuses_anything_a_path_could_escape_through() {
        for domain in [
            "",
            "Relay.example.com",
            "relay..example.com",
            ".example.com",
            "example.com.",
            "x/../../..",
            "..",
            "relay example.com",
            "relay_1.example.com",
        ] {
            assert_eq!(
                RelayDomain::parse(domain),
                Err(InvalidRelayDomain {
                    domain: domain.to_owned()
                }),
                "{domain:?}"
            );
        }
    }

    #[test]
    fn deserialising_runs_the_same_check() {
        assert_eq!(
            serde_json::from_str::<RelayDomain>(r#""relay.example.com""#).unwrap(),
            RelayDomain::parse("relay.example.com").unwrap()
        );
        for json in [r#""x/../..""#, r#""Relay.example.com""#, r#""""#] {
            assert!(serde_json::from_str::<RelayDomain>(json).is_err(), "{json}");
        }
    }
}
