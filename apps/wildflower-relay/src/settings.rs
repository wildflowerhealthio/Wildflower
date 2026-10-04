//! The relay's environment interface.
//!
//! Every setting comes from a `WILDFLOWER_RELAY_*` environment variable;
//! `relay.example.env` lists them all. The environment is the only source:
//! [`ControlSettings`] (the rathole side, including every tunnel and its
//! token) is rendered into a fresh rathole TOML on each start (see
//! [`crate::config`]), [`FrontSettings`] configures the TLS front, which
//! rathole's file has no place for, and [`AcmeSettings`] how the relay's own
//! site gets its certificate. The state directory holds only caches the
//! relay can rebuild, such as that certificate and its ACME account.
//!
//! | Variable | Default |
//! |---|---|
//! | `WILDFLOWER_RELAY_CONFIG` | `relay.toml` (where the rathole TOML is written; read by `main`) |
//! | `WILDFLOWER_RELAY_CONTROL_ADDR` | `0.0.0.0:2333` |
//! | `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY` | required |
//! | `WILDFLOWER_RELAY_TUNNELS` | none (`name=token,name=token`) |
//! | `WILDFLOWER_RELAY_TUNNEL_PORT_BASE` | `5201` |
//! | `WILDFLOWER_RELAY_DOMAIN` | required |
//! | `WILDFLOWER_RELAY_HTTPS_ADDR` | `0.0.0.0:443` |
//! | `WILDFLOWER_RELAY_HTTP_ADDR` | `0.0.0.0:80` |
//! | `WILDFLOWER_RELAY_MAX_CONNECTIONS` | `4096` |
//! | `WILDFLOWER_RELAY_HELLO_TIMEOUT_SECS` | `5` |
//! | `WILDFLOWER_RELAY_STATE_DIR` | `relay-state` (the systemd unit sets `/var/lib/wildflower-relay`) |
//! | `WILDFLOWER_RELAY_ACME_STAGING` | `false` |
//! | `WILDFLOWER_RELAY_ACME_CONTACT` | none (a `mailto:` address) |

use std::fmt::{self, Debug, Display};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
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
    pub acme: AcmeSettings,
    /// Where the relay keeps its caches, e.g. the site's certificate.
    pub state_dir: PathBuf,
}

impl RelaySettings {
    pub const STATE_DIR_VAR: &'static str = "WILDFLOWER_RELAY_STATE_DIR";

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
            acme: AcmeSettings::from_lookup(&lookup)?,
            state_dir: parsed(&lookup, Self::STATE_DIR_VAR, PathBuf::from("relay-state"))?,
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
    /// Every tunnel, sorted by name. Each becomes the rathole service
    /// `[server.services.<name>]`.
    pub tunnels: Vec<Tunnel>,
    /// Loopback port of the first tunnel; the rest follow in name order.
    pub tunnel_port_base: u16,
}

/// One `name=token` entry of `WILDFLOWER_RELAY_TUNNELS`: a device's tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tunnel {
    /// The tunnel name: the device's subdomain and its rathole service name.
    pub name: String,
    /// The tunnel's own rathole token.
    pub token: Secret,
}

impl ControlSettings {
    pub const CONTROL_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_CONTROL_ADDR";
    pub const NOISE_PRIVATE_KEY_VAR: &'static str = "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY";
    pub const TUNNELS_VAR: &'static str = "WILDFLOWER_RELAY_TUNNELS";
    pub const TUNNEL_PORT_BASE_VAR: &'static str = "WILDFLOWER_RELAY_TUNNEL_PORT_BASE";

    /// # Errors
    ///
    /// Returns an error naming the variable if the private key is unset or
    /// empty, a tunnel entry is malformed, or a number or address does not
    /// parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let tunnels = lookup(Self::TUNNELS_VAR)
            .map(|raw| parse_tunnels(&Secret(raw)))
            .transpose()
            .with_context(|| format!("{} is invalid", Self::TUNNELS_VAR))?
            .unwrap_or_default();
        let tunnel_port_base = parsed(&lookup, Self::TUNNEL_PORT_BASE_VAR, 5201)?;
        anyhow::ensure!(
            usize::from(tunnel_port_base) + tunnels.len() <= usize::from(u16::MAX) + 1,
            "{} = {tunnel_port_base} leaves no port for each of the {} tunnels",
            Self::TUNNEL_PORT_BASE_VAR,
            tunnels.len()
        );
        Ok(Self {
            control_addr: parsed(&lookup, Self::CONTROL_ADDR_VAR, ([0, 0, 0, 0], 2333).into())?,
            noise_private_key: required(
                &lookup,
                Self::NOISE_PRIVATE_KEY_VAR,
                "the noise private key from `rathole --genkey`",
            )
            .map(Secret)?,
            tunnels,
            tunnel_port_base,
        })
    }

    /// Each tunnel's name and the loopback address rathole binds for it:
    /// `127.0.0.1:<base + i>` for the `i`th tunnel in name order.
    #[must_use]
    pub fn tunnel_addrs(&self) -> Vec<(String, SocketAddr)> {
        (self.tunnel_port_base..=u16::MAX)
            .zip(&self.tunnels)
            .map(|(port, tunnel)| {
                (
                    tunnel.name.clone(),
                    SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                )
            })
            .collect()
    }
}

/// Parse `name=token,name=token` (whitespace trimmed, blank entries
/// ignored) into tunnels sorted by name. Errors name the entry by position
/// and tunnel name, never the token.
fn parse_tunnels(raw: &Secret) -> anyhow::Result<Vec<Tunnel>> {
    let mut tunnels: Vec<Tunnel> = Vec::new();
    for (index, entry) in raw
        .expose()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .enumerate()
    {
        let position = index + 1;
        let (name, token) = entry
            .split_once('=')
            .with_context(|| format!("entry {position} is not `name=token`"))?;
        let (name, token) = (name.trim(), token.trim());
        anyhow::ensure!(
            is_dns_label(name),
            "entry {position}: tunnel name {name:?} is not a lowercase DNS label"
        );
        anyhow::ensure!(
            !token.is_empty(),
            "entry {position}: tunnel name {name:?} has an empty token"
        );
        anyhow::ensure!(
            tunnels.iter().all(|s| s.name != name),
            "entry {position}: tunnel name {name:?} is listed twice"
        );
        tunnels.push(Tunnel {
            name: name.to_owned(),
            token: Secret::new(token),
        });
    }
    tunnels.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tunnels)
}

/// The front's own settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontSettings {
    /// Public domain suffix: `<tunnel name>.<domain>` routes to that tunnel.
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
    pub const HELLO_TIMEOUT_VAR: &'static str = "WILDFLOWER_RELAY_HELLO_TIMEOUT_SECS";

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
                hello_timeout: secs(Self::HELLO_TIMEOUT_VAR, defaults.hello_timeout)?,
            },
        })
    }

    /// The hostnames the relay serves itself rather than routing to a
    /// tunnel, and orders its certificate for: the domain itself.
    #[must_use]
    pub fn local_hostnames(&self) -> Vec<String> {
        vec![self.domain.clone()]
    }
}

/// How the relay's own site gets its certificate from Let's Encrypt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcmeSettings {
    /// Order from the staging directory instead of production. Its
    /// certificates are not trusted by browsers, and its rate limits are far
    /// higher.
    pub staging: bool,
    /// The ACME account's contact, a `mailto:` URL. `None` registers without
    /// one.
    pub contact: Option<String>,
}

impl AcmeSettings {
    pub const STAGING_VAR: &'static str = "WILDFLOWER_RELAY_ACME_STAGING";
    pub const CONTACT_VAR: &'static str = "WILDFLOWER_RELAY_ACME_CONTACT";

    /// # Errors
    ///
    /// Returns an error naming the variable if the staging flag is not
    /// `true` or `false`, or the contact does not start with `mailto:`.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let contact = lookup(Self::CONTACT_VAR)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(contact) = &contact {
            anyhow::ensure!(
                contact.starts_with("mailto:") && contact.len() > "mailto:".len(),
                "{}={contact:?} is invalid: expected a `mailto:` address",
                Self::CONTACT_VAR
            );
        }
        Ok(Self {
            staging: parsed(&lookup, Self::STAGING_VAR, false)?,
            contact,
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
                    tunnels: Vec::new(),
                    tunnel_port_base: 5201,
                },
                front: FrontSettings {
                    domain: "relay.example.com".to_owned(),
                    https_addr: "0.0.0.0:443".parse().unwrap(),
                    http_addr: "0.0.0.0:80".parse().unwrap(),
                    limits: Limits::default(),
                },
                acme: AcmeSettings {
                    staging: false,
                    contact: None,
                },
                state_dir: PathBuf::from("relay-state"),
            }
        );
        assert_eq!(settings.front.local_hostnames(), ["relay.example.com"]);
    }

    #[test]
    fn reads_overrides() {
        let mut pairs = REQUIRED.to_vec();
        pairs.extend([
            (ControlSettings::CONTROL_ADDR_VAR, "127.0.0.1:7000"),
            (FrontSettings::HTTPS_ADDR_VAR, "[::]:8443"),
            (FrontSettings::HELLO_TIMEOUT_VAR, " 7 "),
            (RelaySettings::STATE_DIR_VAR, "/var/lib/wildflower-relay"),
            (AcmeSettings::STAGING_VAR, "true"),
            (AcmeSettings::CONTACT_VAR, " mailto:ops@example.com "),
        ]);
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(
            settings.control.control_addr,
            "127.0.0.1:7000".parse().unwrap()
        );
        assert_eq!(settings.front.https_addr, "[::]:8443".parse().unwrap());
        assert_eq!(settings.front.limits.hello_timeout, Duration::from_secs(7));
        assert_eq!(
            settings.state_dir,
            PathBuf::from("/var/lib/wildflower-relay")
        );
        assert_eq!(
            settings.acme,
            AcmeSettings {
                staging: true,
                contact: Some("mailto:ops@example.com".to_owned()),
            }
        );
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
        for bad in [
            (FrontSettings::MAX_CONNECTIONS_VAR, "lots"),
            (AcmeSettings::STAGING_VAR, "yes"),
            (AcmeSettings::CONTACT_VAR, "ops@example.com"),
            (AcmeSettings::CONTACT_VAR, "mailto:"),
        ] {
            let mut pairs = REQUIRED.to_vec();
            pairs.push(bad);
            let err = RelaySettings::from_lookup(env(&pairs)).unwrap_err();
            assert!(format!("{err:#}").contains(bad.0), "{bad:?}: {err:#}");
        }
    }

    #[test]
    fn blank_acme_contact_registers_without_one() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((AcmeSettings::CONTACT_VAR, "  "));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(settings.acme.contact, None);
    }

    fn tunnels(raw: &str) -> anyhow::Result<Vec<(String, String)>> {
        parse_tunnels(&Secret::new(raw)).map(|tunnels| {
            tunnels
                .into_iter()
                .map(|s| (s.name, s.token.expose().to_owned()))
                .collect()
        })
    }

    #[test]
    fn tunnels_parse_trimmed_and_sorted_by_name() {
        assert_eq!(
            tunnels(" bob = tok2 ,alice=tok1,, ").unwrap(),
            [
                ("alice".to_owned(), "tok1".to_owned()),
                ("bob".to_owned(), "tok2".to_owned()),
            ]
        );
        assert!(tunnels("").unwrap().is_empty());
        assert!(tunnels(" , ").unwrap().is_empty());
        // Only the first `=` splits; a token may contain more.
        assert_eq!(tunnels("a=b=c").unwrap()[0].1, "b=c");
    }

    #[test]
    fn bad_tunnel_entries_are_named_without_their_token() {
        for (raw, expected) in [
            ("alice=tok1,secret-without-name", "entry 2 is not"),
            (
                "Alice=secret-token",
                "\"Alice\" is not a lowercase DNS label",
            ),
            ("a.b=secret-token", "\"a.b\" is not a lowercase DNS label"),
            ("=secret-token", "\"\" is not a lowercase DNS label"),
            ("alice=  ", "\"alice\" has an empty token"),
            (
                "alice=secret-token,alice=secret-token2",
                "entry 2: tunnel name \"alice\" is listed twice",
            ),
        ] {
            let err = format!("{:#}", tunnels(raw).unwrap_err());
            assert!(err.contains(expected), "{raw:?}: {err}");
            assert!(!err.contains("secret"), "{raw:?}: {err}");
        }
    }

    #[test]
    fn tunnels_and_port_base_come_from_the_environment() {
        let mut pairs = REQUIRED.to_vec();
        pairs.extend([
            (ControlSettings::TUNNELS_VAR, "bob=tok2,alice=tok1"),
            (ControlSettings::TUNNEL_PORT_BASE_VAR, "6000"),
        ]);
        let control = RelaySettings::from_lookup(env(&pairs)).unwrap().control;
        let names: Vec<_> = control.tunnels.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alice", "bob"]);
        assert_eq!(control.tunnel_port_base, 6000);

        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::TUNNELS_VAR, "alice"));
        let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
        assert!(err.contains(ControlSettings::TUNNELS_VAR), "{err}");
    }

    #[test]
    fn tunnel_addrs_count_up_from_the_base_in_name_order() {
        let mut pairs = REQUIRED.to_vec();
        pairs.extend([
            (ControlSettings::TUNNELS_VAR, "carol=t3,alice=t1,bob=t2"),
            (ControlSettings::TUNNEL_PORT_BASE_VAR, "65534"),
        ]);
        let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
        assert!(err.contains(ControlSettings::TUNNEL_PORT_BASE_VAR), "{err}");

        pairs.pop();
        pairs.push((ControlSettings::TUNNEL_PORT_BASE_VAR, "65533"));
        let control = RelaySettings::from_lookup(env(&pairs)).unwrap().control;
        let addrs: Vec<_> = control
            .tunnel_addrs()
            .into_iter()
            .map(|(name, addr)| format!("{name}={addr}"))
            .collect();
        assert_eq!(
            addrs,
            [
                "alice=127.0.0.1:65533",
                "bob=127.0.0.1:65534",
                "carol=127.0.0.1:65535"
            ]
        );
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::TUNNELS_VAR, "alice=tunnel-token"));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("tunnel-token"), "{debug}");
        assert!(!debug.contains("key-value"), "{debug}");
    }
}
