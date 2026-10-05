//! The relay's environment interface.
//!
//! Every setting comes from a `WILDFLOWER_RELAY_*` environment variable;
//! `relay.example.env` lists them all. The environment is the only source:
//! [`ControlSettings`] (the rathole side, including every tunnel and its
//! token) is built into a rathole config on each start (see
//! [`crate::config`]), [`FrontSettings`] configures the TLS front, which
//! rathole's config has no place for, and [`AcmeSettings`] how the relay's own
//! site gets its certificate. [`RelaySettings::public_rathole_settings`] is
//! what the site serves at `GET /rathole`. The admin key signs requests as
//! `keyid="admin"` (see [`crate::site::signature`]). The state directory
//! holds only caches the relay can rebuild, such as that certificate and its
//! ACME account.
//!
//! | Variable | Default |
//! |---|---|
//! | `WILDFLOWER_RELAY_CONTROL_ADDR` | `0.0.0.0:2333` |
//! | `WILDFLOWER_RELAY_PUBLIC_CONTROL_ADDR` | `<domain>:<port of WILDFLOWER_RELAY_CONTROL_ADDR>` |
//! | `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY` | required |
//! | `WILDFLOWER_RELAY_TUNNELS` | none (`name=token,name=token`) |
//! | `WILDFLOWER_RELAY_DOMAIN` | required |
//! | `WILDFLOWER_RELAY_HTTPS_ADDR` | `0.0.0.0:443` |
//! | `WILDFLOWER_RELAY_HTTP_ADDR` | `0.0.0.0:80` |
//! | `WILDFLOWER_RELAY_MAX_CONNECTIONS` | `4096` |
//! | `WILDFLOWER_RELAY_HELLO_TIMEOUT_SECS` | `5` |
//! | `WILDFLOWER_RELAY_STATE_DIR` | `relay-state` (the systemd unit sets `/var/lib/wildflower-relay`) |
//! | `WILDFLOWER_RELAY_ACME_STAGING` | `false` |
//! | `WILDFLOWER_RELAY_ACME_CONTACT` | none (a `mailto:` address) |
//! | `WILDFLOWER_RELAY_ADMIN_KEY` | none (no request can sign as `admin`) |

use std::fmt::{self, Debug, Display};
use std::net::{Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use anyhow::Context;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use curve25519_dalek::MontgomeryPoint;
use rathole_settings_rust::{NoisePattern, PublicRatholeSettings, Transport};

use crate::front::Limits;
use crate::route::is_dns_label;
use crate::site::signature::ADMIN_KEY_ID;

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
    /// The key for requests signed with `keyid="admin"`. `None` means no
    /// request can sign as admin.
    pub admin_key: Option<Secret>,
}

impl RelaySettings {
    pub const STATE_DIR_VAR: &'static str = "WILDFLOWER_RELAY_STATE_DIR";
    pub const ADMIN_KEY_VAR: &'static str = "WILDFLOWER_RELAY_ADMIN_KEY";
    /// The shortest admin key accepted, in bytes.
    pub const ADMIN_KEY_MIN_LEN: usize = 32;

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
    /// empty, one that is set does not parse, or the admin key is shorter
    /// than [`Self::ADMIN_KEY_MIN_LEN`].
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let admin_key = optional(&lookup, Self::ADMIN_KEY_VAR).map(Secret);
        if let Some(admin_key) = &admin_key {
            anyhow::ensure!(
                admin_key.expose().len() >= Self::ADMIN_KEY_MIN_LEN,
                "{} is too short: use at least {} bytes, e.g. `openssl rand -base64 32`",
                Self::ADMIN_KEY_VAR,
                Self::ADMIN_KEY_MIN_LEN
            );
        }
        Ok(Self {
            control: ControlSettings::from_lookup(&lookup)?,
            front: FrontSettings::from_lookup(&lookup)?,
            acme: AcmeSettings::from_lookup(&lookup)?,
            state_dir: parsed(&lookup, Self::STATE_DIR_VAR, PathBuf::from("relay-state"))?,
            admin_key,
        })
    }

    /// What the site serves at `GET /rathole`: the public half of the
    /// rathole settings, for devices' rathole clients. `remote_addr` is
    /// `WILDFLOWER_RELAY_PUBLIC_CONTROL_ADDR`, or the domain at the control
    /// address's port.
    #[must_use]
    pub fn public_rathole_settings(&self) -> PublicRatholeSettings {
        let remote_addr = self.control.public_control_addr.clone().unwrap_or_else(|| {
            format!("{}:{}", self.front.domain, self.control.control_addr.port())
        });
        PublicRatholeSettings {
            remote_addr,
            transport: ControlSettings::TRANSPORT,
            noise_pattern: ControlSettings::NOISE_PATTERN,
            public_key: self.control.noise_public_key.clone(),
            domain: self.front.domain.clone(),
        }
    }
}

/// The rathole keys the relay owns and writes into the TOML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSettings {
    /// `[server] bind_addr`: where devices' rathole clients connect.
    pub control_addr: SocketAddr,
    /// The `host:port` devices' rathole clients dial, when it is not the
    /// domain at [`Self::control_addr`]'s port (e.g. behind port forwarding).
    pub public_control_addr: Option<String>,
    /// `[server.transport.noise] local_private_key` (`rathole --genkey`).
    pub noise_private_key: Secret,
    /// The X25519 public key of [`Self::noise_private_key`], base64: the
    /// `remote_public_key` of every device's rathole client.
    pub noise_public_key: String,
    /// Every tunnel, sorted by name. Each becomes the rathole service
    /// `[server.services.<name>]`.
    pub tunnels: Vec<Tunnel>,
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
    /// `[server.transport] type`.
    pub const TRANSPORT: Transport = Transport::Noise;
    /// `[server.transport.noise] pattern`.
    pub const NOISE_PATTERN: NoisePattern = NoisePattern::Nk25519ChaChaPolyBlake2s;

    pub const CONTROL_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_CONTROL_ADDR";
    pub const PUBLIC_CONTROL_ADDR_VAR: &'static str = "WILDFLOWER_RELAY_PUBLIC_CONTROL_ADDR";
    pub const NOISE_PRIVATE_KEY_VAR: &'static str = "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY";
    pub const TUNNELS_VAR: &'static str = "WILDFLOWER_RELAY_TUNNELS";

    /// # Errors
    ///
    /// Returns an error naming the variable if the private key is unset,
    /// empty or not a base64 X25519 key, a tunnel entry is malformed, or a
    /// number or address does not parse.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let tunnels = lookup(Self::TUNNELS_VAR)
            .map(|raw| parse_tunnels(&Secret(raw)))
            .transpose()
            .with_context(|| format!("{} is invalid", Self::TUNNELS_VAR))?
            .unwrap_or_default();
        let public_control_addr = lookup(Self::PUBLIC_CONTROL_ADDR_VAR)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .map(|value| {
                parse_public_addr(&value).map_err(|e| {
                    anyhow::anyhow!(
                        "{}={value:?} is invalid: {e}",
                        Self::PUBLIC_CONTROL_ADDR_VAR
                    )
                })
            })
            .transpose()?;
        let noise_private_key = required(
            &lookup,
            Self::NOISE_PRIVATE_KEY_VAR,
            "the noise private key from `rathole --genkey`",
        )
        .map(Secret)?;
        let noise_public_key = noise_public_key(&noise_private_key)
            .with_context(|| format!("{} is invalid", Self::NOISE_PRIVATE_KEY_VAR))?;
        Ok(Self {
            control_addr: parsed(&lookup, Self::CONTROL_ADDR_VAR, ([0, 0, 0, 0], 2333).into())?,
            public_control_addr,
            noise_private_key,
            noise_public_key,
            tunnels,
        })
    }

    /// Every tunnel's name, in name order.
    pub fn tunnel_names(&self) -> impl Iterator<Item = String> + '_ {
        self.tunnels.iter().map(|tunnel| tunnel.name.clone())
    }
}

/// The X25519 public key, base64, for a base64 private key from `rathole
/// --genkey`: the base point times the clamped private scalar, as snow
/// derives it when rathole generates the pair. Errors never contain the key.
fn noise_public_key(private_key: &Secret) -> anyhow::Result<String> {
    let bytes = BASE64
        .decode(private_key.expose())
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .context("expected 32 bytes of base64, as `rathole --genkey` prints")?;
    Ok(BASE64.encode(MontgomeryPoint::mul_base_clamped(bytes).to_bytes()))
}

/// Validate a `host:port` for clients to dial and case-fold it. The host is
/// lowercase DNS labels (which covers an IPv4 address) or a bracketed IPv6
/// address; the port is 1–65535.
fn parse_public_addr(raw: &str) -> anyhow::Result<String> {
    let addr = raw.to_ascii_lowercase();
    let (host, port) = addr.rsplit_once(':').context("expected `host:port`")?;
    anyhow::ensure!(
        port.parse::<u16>().is_ok_and(|port| port != 0),
        "port {port:?} is not 1–65535"
    );
    let host_is_valid = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(ipv6) => ipv6.parse::<Ipv6Addr>().is_ok(),
        None => host.split('.').all(is_dns_label),
    };
    anyhow::ensure!(
        host_is_valid,
        "host {host:?} is not a DNS name or IP address"
    );
    Ok(addr)
}

/// Parse `name=token,name=token` (whitespace trimmed, blank entries
/// ignored) into tunnels sorted by name. `admin` is reserved: it is the
/// `keyid` of the admin key. Errors name the entry by position
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
            name != ADMIN_KEY_ID,
            "entry {position}: tunnel name {name:?} is reserved"
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
        let contact = optional(&lookup, Self::CONTACT_VAR);
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
    optional(lookup, name).with_context(|| format!("{name} is not set — {what}"))
}

/// An optional variable, trimmed; `None` when unset or blank.
fn optional(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
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

    /// A key pair printed by `rathole --genkey` (rathole 0.5.0).
    const GENKEY_PRIVATE_KEY: &str = "HY1kqeX1WAAysgpriYop7NW/Yw7KAO//EdEBs8qxv7I=";
    const GENKEY_PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";

    const REQUIRED: [(&str, &str); 2] = [
        (FrontSettings::DOMAIN_VAR, ".Relay.Example.com."),
        (ControlSettings::NOISE_PRIVATE_KEY_VAR, GENKEY_PRIVATE_KEY),
    ];

    #[test]
    fn defaults_everything_but_the_required_values() {
        let settings = RelaySettings::from_lookup(env(&REQUIRED)).unwrap();
        assert_eq!(
            settings,
            RelaySettings {
                control: ControlSettings {
                    control_addr: "0.0.0.0:2333".parse().unwrap(),
                    public_control_addr: None,
                    noise_private_key: Secret::new(GENKEY_PRIVATE_KEY),
                    noise_public_key: GENKEY_PUBLIC_KEY.to_owned(),
                    tunnels: Vec::new(),
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
                admin_key: None,
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
    fn bad_public_control_addrs_are_rejected() {
        for bad in [
            "relay.example.com",
            "relay.example.com:0",
            "relay.example.com:http",
            ":2333",
            "relay..example.com:2333",
            "user@relay.example.com:2333",
            "[relay.example.com]:2333",
            "::1:2333",
        ] {
            let mut pairs = REQUIRED.to_vec();
            pairs.push((ControlSettings::PUBLIC_CONTROL_ADDR_VAR, bad));
            let err = RelaySettings::from_lookup(env(&pairs)).unwrap_err();
            assert!(
                format!("{err:#}").contains(ControlSettings::PUBLIC_CONTROL_ADDR_VAR),
                "{bad:?}: {err:#}"
            );
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
            ("admin=secret-token", "\"admin\" is reserved"),
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
    fn tunnels_come_from_the_environment_in_name_order() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::TUNNELS_VAR, "bob=tok2,alice=tok1"));
        let control = RelaySettings::from_lookup(env(&pairs)).unwrap().control;
        let names: Vec<_> = control.tunnel_names().collect();
        assert_eq!(names, ["alice", "bob"]);

        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::TUNNELS_VAR, "alice"));
        let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
        assert!(err.contains(ControlSettings::TUNNELS_VAR), "{err}");
    }

    #[test]
    fn admin_key_is_optional_trimmed_and_at_least_32_bytes() {
        let key = "an-admin-key-of-thirty-two-bytes";
        let mut pairs = REQUIRED.to_vec();
        pairs.push((
            RelaySettings::ADMIN_KEY_VAR,
            " an-admin-key-of-thirty-two-bytes ",
        ));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(settings.admin_key, Some(Secret::new(key)));

        let mut pairs = REQUIRED.to_vec();
        pairs.push((RelaySettings::ADMIN_KEY_VAR, "  "));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(settings.admin_key, None);

        let mut pairs = REQUIRED.to_vec();
        pairs.push((RelaySettings::ADMIN_KEY_VAR, "secret-but-too-short"));
        let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
        assert!(err.contains(RelaySettings::ADMIN_KEY_VAR), "{err}");
        assert!(!err.contains("secret"), "{err}");
    }

    #[test]
    fn debug_output_never_contains_secrets() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::TUNNELS_VAR, "alice=tunnel-token"));
        pairs.push((
            RelaySettings::ADMIN_KEY_VAR,
            "the-admin-key-of-thirty-two-byte",
        ));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("tunnel-token"), "{debug}");
        assert!(!debug.contains("the-admin-key"), "{debug}");
        assert!(!debug.contains(GENKEY_PRIVATE_KEY), "{debug}");
    }

    #[test]
    fn noise_public_key_matches_rathole_genkey() {
        assert_eq!(
            noise_public_key(&Secret::new(GENKEY_PRIVATE_KEY)).unwrap(),
            GENKEY_PUBLIC_KEY
        );
    }

    #[test]
    fn a_noise_private_key_that_is_not_32_bytes_of_base64_is_rejected_unprinted() {
        for bad in ["secret-not-base64!", "c2VjcmV0LXRvby1zaG9ydA=="] {
            let mut pairs = REQUIRED.to_vec();
            pairs.retain(|&(name, _)| name != ControlSettings::NOISE_PRIVATE_KEY_VAR);
            pairs.push((ControlSettings::NOISE_PRIVATE_KEY_VAR, bad));
            let err = format!("{:#}", RelaySettings::from_lookup(env(&pairs)).unwrap_err());
            assert!(
                err.contains(ControlSettings::NOISE_PRIVATE_KEY_VAR),
                "{bad:?}: {err}"
            );
            assert!(!err.contains(bad), "{bad:?}: {err}");
        }
    }

    #[test]
    fn public_rathole_settings_default_to_the_domain_at_the_control_port() {
        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::CONTROL_ADDR_VAR, "0.0.0.0:7000"));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(
            settings.public_rathole_settings(),
            PublicRatholeSettings {
                remote_addr: "relay.example.com:7000".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: GENKEY_PUBLIC_KEY.to_owned(),
                domain: "relay.example.com".to_owned(),
            }
        );
    }

    #[test]
    fn public_control_addr_overrides_the_default_remote_addr() {
        for (raw, expected) in [
            (" Tunnels.Example.com:443 ", "tunnels.example.com:443"),
            ("203.0.113.7:2333", "203.0.113.7:2333"),
            ("[2001:db8::1]:2333", "[2001:db8::1]:2333"),
        ] {
            let mut pairs = REQUIRED.to_vec();
            pairs.extend([
                (ControlSettings::CONTROL_ADDR_VAR, "0.0.0.0:7000"),
                (ControlSettings::PUBLIC_CONTROL_ADDR_VAR, raw),
            ]);
            let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
            assert_eq!(
                settings.public_rathole_settings().remote_addr,
                expected,
                "{raw:?}"
            );
        }

        let mut pairs = REQUIRED.to_vec();
        pairs.push((ControlSettings::PUBLIC_CONTROL_ADDR_VAR, "  "));
        let settings = RelaySettings::from_lookup(env(&pairs)).unwrap();
        assert_eq!(
            settings.public_rathole_settings().remote_addr,
            "relay.example.com:2333"
        );
    }
}
