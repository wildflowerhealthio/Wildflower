//! [`ServerRecord`]: one server this install knows about, as the registry
//! stores it. A server is identified by its [`domain`](ServerRecord::domain),
//! `<tunnel name>.<relay domain>`; it has no other name.
//!
//! The record holds configuration only. Whether the server is running, its
//! tunnel's liveness and its certificate are live state, held by whatever runs
//! the server, never here.

use rathole_settings_rust::{PublicRatholeSettings, TunnelName};
use serde::{Deserialize, Serialize, Serializer};
use url::Url;

/// One server: the relay it is reached through, the tunnel it holds there,
/// and how it launches apps.
///
/// `Serialize` writes the token as a redaction marker (see [`TunnelToken`]),
/// so serialising a record anywhere other than `servers.json` cannot leak it.
/// The registry adapter writes the file through its own representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerRecord {
    /// The relay this server's tunnel runs through.
    pub relay: Relay,
    /// The tunnel's name at the relay, which is also its rathole service name.
    pub tunnel_name: TunnelName,
    /// The tunnel's token at the relay.
    pub token: TunnelToken,
    /// What the relay returned from `GET /rathole` when the server was added:
    /// the only copy of the relay's dial address and noise key, which the
    /// tunnel client always dials.
    pub public_settings: PublicRatholeSettings,
    /// The page the base opens to launch apps against this server, with `iss`
    /// and `launch` in its query. A new server gets
    /// [`DEFAULT_LAUNCHER_URL`](ServerRecord::DEFAULT_LAUNCHER_URL).
    pub launcher_url: Url,
    /// Whether this server's certificates come from the ACME staging directory
    /// instead of production.
    pub staging_certificates: bool,
}

impl ServerRecord {
    /// The launcher a new server gets: the hosted owner UI's app section
    /// (`sectionUrl('app')`).
    pub const DEFAULT_LAUNCHER_URL: &'static str = "https://wildflowerhealth.io/app";

    /// [`DEFAULT_LAUNCHER_URL`](Self::DEFAULT_LAUNCHER_URL) as a [`Url`].
    ///
    /// # Panics
    ///
    /// Never: the constant is an absolute URL, which a test checks.
    #[must_use]
    pub fn default_launcher_url() -> Url {
        Url::parse(Self::DEFAULT_LAUNCHER_URL).expect("DEFAULT_LAUNCHER_URL is an absolute URL")
    }

    /// The server's domain, `<tunnel name>.<relay domain>`: its identity in
    /// the registry, its issuer, and the name of its data folder.
    #[must_use]
    pub fn domain(&self) -> String {
        format!("{}.{}", self.tunnel_name, self.public_settings.domain)
    }
}

/// The relay a server's tunnel runs through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Relay {
    /// The relay Wildflower runs.
    Wildflower,
    /// A relay the user runs or chose, entered by hand. What its rathole
    /// client dials comes from its `GET /rathole`, kept in the record's
    /// `public_settings`.
    Custom {
        /// The relay's site, where it serves `GET /rathole`.
        base_url: Url,
    },
}

impl Relay {
    /// The site of the relay Wildflower runs.
    pub const WILDFLOWER_BASE_URL: &'static str = "https://relay.wildflowerhealth.io";

    /// The relay's site, where it serves `GET /rathole` and `GET /me`:
    /// [`WILDFLOWER_BASE_URL`](Self::WILDFLOWER_BASE_URL) for
    /// [`Relay::Wildflower`], the entered `base_url` for [`Relay::Custom`].
    ///
    /// # Panics
    ///
    /// Never: [`WILDFLOWER_BASE_URL`](Self::WILDFLOWER_BASE_URL) is an
    /// absolute URL, which a test checks.
    #[must_use]
    pub fn base_url(&self) -> Url {
        match self {
            Self::Wildflower => Url::parse(Self::WILDFLOWER_BASE_URL)
                .expect("WILDFLOWER_BASE_URL is an absolute URL"),
            Self::Custom { base_url } => base_url.clone(),
        }
    }
}

/// A tunnel's token at the relay: a secret.
///
/// `Debug` and `Serialize` both write [`TunnelToken::REDACTED`] in its place,
/// and there is no `Deserialize`, so the only way to the value is
/// [`expose`](TunnelToken::expose).
#[derive(Clone, PartialEq, Eq)]
pub struct TunnelToken(String);

impl TunnelToken {
    /// What `Debug` and `Serialize` write instead of the token.
    pub const REDACTED: &'static str = "<redacted>";

    #[must_use]
    pub fn new(token: impl Into<String>) -> Self {
        Self(token.into())
    }

    /// The token itself, for the rathole client config and `servers.json`.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for TunnelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TunnelToken({})", Self::REDACTED)
    }
}

impl Serialize for TunnelToken {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(Self::REDACTED)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use rathole_settings_rust::{NoisePattern, Transport};

    use super::*;

    pub(crate) const TOKEN: &str = "s3cret-tunnel-token";

    pub(crate) fn wildflower_record(tunnel_name: &str) -> ServerRecord {
        ServerRecord {
            relay: Relay::Wildflower,
            tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
            token: TunnelToken::new(TOKEN),
            public_settings: PublicRatholeSettings {
                remote_addr: "relay.wildflowerhealth.io:2333".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
                domain: "relay.wildflowerhealth.io".to_owned(),
            },
            launcher_url: ServerRecord::default_launcher_url(),
            staging_certificates: false,
        }
    }

    pub(crate) fn custom_record(tunnel_name: &str) -> ServerRecord {
        ServerRecord {
            relay: Relay::Custom {
                base_url: Url::parse("https://relay.example.com").unwrap(),
            },
            tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
            token: TunnelToken::new(TOKEN),
            public_settings: PublicRatholeSettings {
                remote_addr: "relay.example.com:2333".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIExampleNoiseKey=".to_owned(),
                domain: "relay.example.com".to_owned(),
            },
            launcher_url: Url::parse("https://launcher.example.com/").unwrap(),
            staging_certificates: true,
        }
    }

    #[test]
    fn the_default_launcher_is_the_hosted_owner_ui_s_app_section() {
        assert_eq!(
            ServerRecord::default_launcher_url().as_str(),
            "https://wildflowerhealth.io/app"
        );
    }

    #[test]
    fn a_relay_s_base_url_is_wildflower_s_site_or_the_entered_one() {
        assert_eq!(
            Relay::Wildflower.base_url().as_str(),
            "https://relay.wildflowerhealth.io/"
        );
        assert_eq!(
            custom_record("lab").relay.base_url().as_str(),
            "https://relay.example.com/"
        );
    }

    #[test]
    fn domain_is_the_tunnel_name_under_the_relay_domain() {
        assert_eq!(
            wildflower_record("ruth").domain(),
            "ruth.relay.wildflowerhealth.io"
        );
        assert_eq!(custom_record("lab").domain(), "lab.relay.example.com");
    }

    #[test]
    fn debug_redacts_the_token() {
        let rendered = format!("{:?}", wildflower_record("ruth"));
        assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
        assert!(
            rendered.contains(TunnelToken::REDACTED),
            "no redaction marker: {rendered}"
        );
        assert!(rendered.contains("ruth"), "tunnel name hidden: {rendered}");
    }

    #[test]
    fn serialising_a_record_redacts_the_token() {
        let rendered = serde_json::to_string(&custom_record("lab")).unwrap();
        assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
        assert!(
            rendered.contains(r#""token":"<redacted>""#),
            "no redaction marker: {rendered}"
        );
    }
}
