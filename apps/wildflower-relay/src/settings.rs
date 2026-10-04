//! The relay's environment interface.
//!
//! Every setting comes from a `WILDFLOWER_RELAY_*` environment variable. The
//! rathole `[server]` keys ([`ControlSettings`]) are written into the rathole
//! TOML at startup (see [`crate::config`]); the front's own settings
//! ([`FrontSettings`]) never touch that file, because rathole parses it
//! itself and rejects unknown keys.
//!
//! | Variable | Default |
//! |---|---|
//! | `WILDFLOWER_RELAY_CONFIG` | `relay.toml` (path of the rathole TOML; read by `main`) |
//! | `WILDFLOWER_RELAY_CONTROL_ADDR` | `0.0.0.0:2333` |
//! | `WILDFLOWER_RELAY_DEFAULT_TOKEN` | required |
//! | `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY` | required |
//! | `WILDFLOWER_RELAY_DOMAIN` | required |
//! | `WILDFLOWER_RELAY_HTTPS_ADDR` | `0.0.0.0:443` |
//! | `WILDFLOWER_RELAY_HTTP_ADDR` | `0.0.0.0:80` |
//! | `WILDFLOWER_RELAY_MAX_CONNECTIONS` | `4096` |
//! | `WILDFLOWER_RELAY_MAX_CONNECTIONS_PER_LABEL` | `256` |
//! | `WILDFLOWER_RELAY_HELLO_TIMEOUT_SECS` | `5` |
//! | `WILDFLOWER_RELAY_IDLE_TIMEOUT_SECS` | `300` |

use std::fmt::{self, Debug, Display};
use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;

use anyhow::Context;

use crate::front::Limits;

/// A secret read from the environment. `Debug` never prints it, so settings
/// can be logged or put in error context safely.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Everything the relay reads from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub control: ControlSettings,
    pub front: FrontSettings,
}

impl RelaySettings {
    /// Read the settings from the process environment.
    ///
    /// # Errors
    ///
    /// See [`RelaySettings::from_lookup`].
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Read the settings through `lookup` (an env-var getter).
    ///
    /// # Errors
    ///
    /// Returns an error naming the variable if a required one is unset or
    /// empty, or one that is set does not parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        Ok(Self {
            control: ControlSettings::from_lookup(&lookup)?,
            front: FrontSettings::from_lookup(&lookup)?,
        })
    }
}

/// The rathole `[server]` keys the relay owns and writes into the TOML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSettings {
    /// `[server] bind_addr`: where devices' rathole clients connect.
    pub control_addr: SocketAddr,
    /// `[server] default_token`: the token for services without their own.
    pub default_token: Secret,
    /// `[server.transport.noise] local_private_key` (`rathole --genkey`).
    pub noise_private_key: Secret,
}

impl ControlSettings {
    pub const CONTROL_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_CONTROL_ADDR";
    pub const DEFAULT_TOKEN_VAR: &'static str = "WILDFLOWER_RELAY_DEFAULT_TOKEN";
    pub const NOISE_PRIVATE_KEY_VAR: &'static str = "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY";

    /// # Errors
    ///
    /// Returns an error naming the variable if a secret is unset or empty, or
    /// the control address does not parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        Ok(Self {
            control_addr: parsed(&lookup, Self::CONTROL_ADDR_VAR, ([0, 0, 0, 0], 2333).into())?,
            default_token: required(&lookup, Self::DEFAULT_TOKEN_VAR, "the shared rathole token")
                .map(Secret)?,
            noise_private_key: required(
                &lookup,
                Self::NOISE_PRIVATE_KEY_VAR,
                "the noise private key from `rathole --genkey`",
            )
            .map(Secret)?,
        })
    }
}

/// The front's own settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontSettings {
    /// Public domain suffix: `<label>.<domain>` routes to service `<label>`.
    pub domain: String,
    pub https_addr: SocketAddr,
    pub http_addr: SocketAddr,
    pub limits: Limits,
}

impl FrontSettings {
    pub const DOMAIN_VAR: &'static str = "WILDFLOWER_RELAY_DOMAIN";
    pub const HTTPS_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_HTTPS_ADDR";
    pub const HTTP_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_HTTP_ADDR";
    pub const MAX_CONNECTIONS_VAR: &'static str = "WILDFLOWER_RELAY_MAX_CONNECTIONS";
    pub const MAX_CONNECTIONS_PER_LABEL_VAR: &'static str =
        "WILDFLOWER_RELAY_MAX_CONNECTIONS_PER_LABEL";
    pub const HELLO_TIMEOUT_VAR: &'static str = "WILDFLOWER_RELAY_HELLO_TIMEOUT_SECS";
    pub const IDLE_TIMEOUT_VAR: &'static str = "WILDFLOWER_RELAY_IDLE_TIMEOUT_SECS";

    /// Only the domain is required; everything else has a default.
    ///
    /// # Errors
    ///
    /// Returns an error if the domain is unset or empty, or a variable that
    /// is set does not parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let domain = required(
            &lookup,
            Self::DOMAIN_VAR,
            "the public domain suffix, e.g. relay.example.com",
        )?
        .trim_matches('.')
        .to_ascii_lowercase();
        let defaults = Limits::default();
        let secs = |name, default: Duration| {
            parsed(&lookup, name, default.as_secs()).map(Duration::from_secs)
        };
        Ok(Self {
            domain,
            https_addr: parsed(&lookup, Self::HTTPS_ADDR_VAR, ([0, 0, 0, 0], 443).into())?,
            http_addr: parsed(&lookup, Self::HTTP_ADDR_VAR, ([0, 0, 0, 0], 80).into())?,
            limits: Limits {
                max_connections: parsed(
                    &lookup,
                    Self::MAX_CONNECTIONS_VAR,
                    defaults.max_connections,
                )?,
                max_connections_per_label: parsed(
                    &lookup,
                    Self::MAX_CONNECTIONS_PER_LABEL_VAR,
                    defaults.max_connections_per_label,
                )?,
                hello_timeout: secs(Self::HELLO_TIMEOUT_VAR, defaults.hello_timeout)?,
                idle_timeout: secs(Self::IDLE_TIMEOUT_VAR, defaults.idle_timeout)?,
            },
        })
    }
}

/// A required, non-empty variable (trimmed). The error names the variable
/// and what it is, never a value.
fn required(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    what: &str,
) -> anyhow::Result<String> {
    lookup(name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{name} is not set — {what}"))
}

/// An optional variable parsed as `T`, or `default` when unset.
fn parsed<T>(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: T) -> anyhow::Result<T>
where
    T: FromStr,
    T::Err: Display,
{
    match lookup(name) {
        None => Ok(default),
        Some(raw) => raw
            .trim()
            .parse()
            .map_err(|e| anyhow::anyhow!("{name}={raw:?} is invalid: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn env(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        move |name| map.get(name).map(|v| (*v).to_owned())
    }

    const REQUIRED: [(&str, &str); 3] = [
        (FrontSettings::DOMAIN_VAR, ".Relay.Example.com."),
        (ControlSettings::DEFAULT_TOKEN_VAR, "token-value"),
        (ControlSettings::NOISE_PRIVATE_KEY_VAR, "key-value"),
    ];

    #[test]
    fn defaults_everything_but_the_required_values() {
        let settings = RelaySettings::from_lookup(env(&REQUIRED)).unwrap();
        assert_eq!(
            settings,
            RelaySettings {
                control: ControlSettings {
                    control_addr: "0.0.0.0:2333".parse().unwrap(),
                    default_token: Secret::new("token-value"),
                    noise_private_key: Secret::new("key-value"),
                },
                front: FrontSettings {
                    domain: "relay.example.com".to_owned(),
                    https_addr: "0.0.0.0:443".parse().unwrap(),
                    http_addr: "0.0.0.0:80".parse().unwrap(),
                    limits: Limits::default(),
                },
            }
        );
    }

    #[test]
    fn reads_overrides() {
        let mut pairs = REQUIRED.to_vec();
        pairs.extend([
            (ControlSettings::CONTROL_ADDR_VAR, "127.0.0.1:7000"),
            (FrontSettings::HTTPS_ADDR_VAR, "[::]:8443"),
            (FrontSettings::IDLE_TIMEOUT_VAR, " 60 "),
            (FrontSettings::MAX_CONNECTIONS_PER_LABEL_VAR, "8"),
        ]);
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(
            settings.control.control_addr,
            "127.0.0.1:7000".parse().unwrap()
        );
        assert_eq!(settings.front.https_addr, "[::]:8443".parse().unwrap());
        assert_eq!(settings.front.limits.idle_timeout, Duration::from_secs(60));
        assert_eq!(settings.front.limits.max_connections_per_label, 8);
    }

    #[test]
    fn missing_or_blank_required_values_name_the_variable() {
        for missing in REQUIRED.map(|(name, _)| name) {
            let pairs: Vec<_> = REQUIRED
                .iter()
                .map(|&(name, value)| (name, if name == missing { "  " } else { value }))
                .collect();
            let err = RelaySettings::from_lookup(env(&pairs)).unwrap_err();
            assert!(format!("{err:#}").contains(missing), "{err:#}");

            let pairs: Vec<_> = REQUIRED
                .iter()
                .copied()
                .filter(|&(name, _)| name != missing)
                .collect();
            let err = RelaySettings::from_lookup(env(&pairs)).unwrap_err();
            assert!(format!("{err:#}").contains(missing), "{err:#}");
        }
    }

    #[test]
    fn bad_values_are_rejected() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((FrontSettings::MAX_CONNECTIONS_VAR, "lots"));
        assert!(RelaySettings::from_lookup(env(&pairs)).is_err());
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let settings = RelaySettings::from_lookup(env(&REQUIRED)).unwrap();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("token-value"), "{debug}");
        assert!(!debug.contains("key-value"), "{debug}");
    }
}
