//! The relay's environment interface.
//!
//! Every setting comes from a `WILDFLOWER_RELAY_*` environment variable. The
//! rathole `[server]` keys ([`ControlSettings`]) are written into the rathole
//! TOML at startup (see [`crate::config`]); the front's own settings
//! ([`FrontSettings`]) never touch that file, because rathole parses it
//! itself and rejects unknown keys. There is no shared token: every service
//! carries its own `token`, written by enrolment or listed in
//! `WILDFLOWER_RELAY_SERVICES` (for hosts whose disk does not persist).
//!
//! | Variable | Default |
//! |---|---|
//! | `WILDFLOWER_RELAY_CONFIG` | `relay.toml` (path of the rathole TOML; read by `main`) |
//! | `WILDFLOWER_RELAY_CONTROL_ADDR` | `0.0.0.0:2333` |
//! | `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY` | required |
//! | `WILDFLOWER_RELAY_SERVICES` | none (`label=token,label=token`) |
//! | `WILDFLOWER_RELAY_SERVICE_PORT_BASE` | `5201` |
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
use crate::route::is_dns_label;

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

/// The rathole keys the relay owns and writes into the TOML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSettings {
    /// `[server] bind_addr`: where devices' rathole clients connect.
    pub control_addr: SocketAddr,
    /// `[server.transport.noise] local_private_key` (`rathole --genkey`).
    pub noise_private_key: Secret,
    /// Device services from the environment, sorted by label. Each becomes
    /// `[server.services.<label>]`, replacing a file entry of the same name.
    pub services: Vec<EnvService>,
    /// First loopback port handed to [`ControlSettings::services`].
    pub service_port_base: u16,
}

/// One `label=token` entry of `WILDFLOWER_RELAY_SERVICES`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvService {
    /// The device's subdomain label and rathole service name.
    pub label: String,
    /// The service's own rathole token.
    pub token: Secret,
}

impl ControlSettings {
    pub const CONTROL_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_CONTROL_ADDR";
    pub const NOISE_PRIVATE_KEY_VAR: &'static str = "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY";
    pub const SERVICES_VAR: &'static str = "WILDFLOWER_RELAY_SERVICES";
    pub const SERVICE_PORT_BASE_VAR: &'static str = "WILDFLOWER_RELAY_SERVICE_PORT_BASE";

    /// # Errors
    ///
    /// Returns an error naming the variable if the private key is unset or
    /// empty, a service entry is malformed, or a number or address does not
    /// parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let services = lookup(Self::SERVICES_VAR)
            .map(|raw| parse_services(&Secret(raw)))
            .transpose()
            .with_context(|| format!("{} is invalid", Self::SERVICES_VAR))?
            .unwrap_or_default();
        Ok(Self {
            control_addr: parsed(&lookup, Self::CONTROL_ADDR_VAR, ([0, 0, 0, 0], 2333).into())?,
            noise_private_key: required(
                &lookup,
                Self::NOISE_PRIVATE_KEY_VAR,
                "the noise private key from `rathole --genkey`",
            )
            .map(Secret)?,
            services,
            service_port_base: parsed(&lookup, Self::SERVICE_PORT_BASE_VAR, 5201)?,
        })
    }
}

/// Parse `label=token,label=token` (whitespace trimmed, blank entries
/// ignored) into services sorted by label. Errors name the entry by position
/// and label, never the token.
fn parse_services(raw: &Secret) -> anyhow::Result<Vec<EnvService>> {
    let mut services: Vec<EnvService> = Vec::new();
    for (index, entry) in raw
        .expose()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .enumerate()
    {
        let position = index + 1;
        let (label, token) = entry
            .split_once('=')
            .with_context(|| format!("entry {position} is not `label=token`"))?;
        let (label, token) = (label.trim(), token.trim());
        anyhow::ensure!(
            is_dns_label(label),
            "entry {position}: label {label:?} is not a lowercase DNS label"
        );
        anyhow::ensure!(
            !token.is_empty(),
            "entry {position}: label {label:?} has an empty token"
        );
        anyhow::ensure!(
            services.iter().all(|s| s.label != label),
            "entry {position}: label {label:?} is listed twice"
        );
        services.push(EnvService {
            label: label.to_owned(),
            token: Secret::new(token),
        });
    }
    services.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(services)
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

    const REQUIRED: [(&str, &str); 2] = [
        (FrontSettings::DOMAIN_VAR, ".Relay.Example.com."),
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
                    noise_private_key: Secret::new("key-value"),
                    services: Vec::new(),
                    service_port_base: 5201,
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

    fn services(raw: &str) -> anyhow::Result<Vec<(String, String)>> {
        parse_services(&Secret::new(raw)).map(|services| {
            services
                .into_iter()
                .map(|s| (s.label, s.token.expose().to_owned()))
                .collect()
        })
    }

    #[test]
    fn services_parse_trimmed_and_sorted_by_label() {
        assert_eq!(
            services(" bob = tok2 ,alice=tok1,, ").unwrap(),
            [
                ("alice".to_owned(), "tok1".to_owned()),
                ("bob".to_owned(), "tok2".to_owned()),
            ]
        );
        assert!(services("").unwrap().is_empty());
        assert!(services(" , ").unwrap().is_empty());
        // Only the first `=` splits; a token may contain more.
        assert_eq!(services("a=b=c").unwrap()[0].1, "b=c");
    }

    #[test]
    fn bad_service_entries_are_named_without_their_token() {
        for (raw, expected) in [
            ("alice=tok1,secret-without-label", "entry 2 is not"),
            (
                "Alice=secret-token",
                "\"Alice\" is not a lowercase DNS label",
            ),
            ("a.b=secret-token", "\"a.b\" is not a lowercase DNS label"),
            ("=secret-token", "\"\" is not a lowercase DNS label"),
            ("alice=  ", "\"alice\" has an empty token"),
            (
                "alice=secret-token,alice=secret-token2",
                "entry 2: label \"alice\" is listed twice",
            ),
        ] {
            let err = format!("{:#}", services(raw).unwrap_err());
            assert!(err.contains(expected), "{raw:?}: {err}");
            assert!(!err.contains("secret"), "{raw:?}: {err}");
        }
    }

    #[test]
    fn services_and_port_base_come_from_the_environment() {
        let mut pairs = REQUIRED.to_vec();
        pairs.extend([
            (ControlSettings::SERVICES_VAR, "bob=tok2,alice=tok1"),
            (ControlSettings::SERVICE_PORT_BASE_VAR, "6000"),
        ]);
        let control = RelaySettings::from_lookup(env(&pairs)).unwrap().control;
        let labels: Vec<_> = control.services.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(labels, ["alice", "bob"]);
        assert_eq!(control.service_port_base, 6000);

        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::SERVICES_VAR, "alice"));
        let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
        assert!(err.contains(ControlSettings::SERVICES_VAR), "{err}");
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::SERVICES_VAR, "alice=service-token"));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("service-token"), "{debug}");
        assert!(!debug.contains("key-value"), "{debug}");
    }
}
