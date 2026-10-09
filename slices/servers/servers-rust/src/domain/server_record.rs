//! [`ServerRecord`]: one server this install knows about, as the registry
//! stores it. A server is identified by its [`domain`](ServerRecord::domain),
//! `<tunnel name>.<relay domain>`; it has no other name.
//!
//! The record holds configuration only, its
//! [`run_policy`](ServerRecord::run_policy) included: when the user wants the
//! server run, not whether a run is up. A run's state, its reachability and
//! its certificate are live state, held by whatever runs the server, never
//! here.

use std::path::{Path, PathBuf};

use rathole_settings_rust::{PublicRatholeSettings, TunnelName};
use serde::{Deserialize, Serialize, Serializer};
use unit_runner::RunPolicy;
use url::Url;
use wildflower_server_rust::DeviceCertificateConfig;

use crate::domain::CertificateAuthority;

/// The folder in the data root that holds one folder per server, named by its
/// [`domain`](ServerRecord::domain).
pub const SERVERS_DIR_NAME: &str = "servers";

/// The folder in the data root that holds the install's ACME account keys,
/// one per CA, which every server orders its certificates with. Removing a
/// server leaves it.
const ACME_ACCOUNT_DIR_NAME: &str = "acme-account";

/// The folder in a server's folder that holds its certificates and their
/// keys (see [`ServerRecord::certificate_dir`]).
const CERTIFICATES_DIR_NAME: &str = "certificates";

/// One server: the relay it is reached through, the tunnel it holds there,
/// and how it launches apps.
///
/// `Serialize` writes the token as a redaction marker (see [`TunnelToken`]),
/// so serialising a record anywhere other than `servers.json` cannot leak it.
/// The registry adapter writes the file through its own representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    /// The relay this server's tunnel runs through.
    pub relay: RelayKind,
    /// The tunnel's name at the relay, which is also its rathole service name.
    pub tunnel_name: TunnelName,
    /// The tunnel's token at the relay.
    pub token: TunnelToken,
    /// What the relay returned from `GET /rathole` when the server was added,
    /// or, for a [`RelayKind::Rathole`] one, what was entered: the only
    /// copy of the relay's dial address and noise key, which the tunnel client
    /// always dials.
    pub public_settings: PublicRatholeSettings,
    /// The page the base opens to launch apps against this server, with `iss`
    /// and `launch` in its query. A new server gets the default launcher
    /// [`add_server`](crate::add_server) is given.
    pub launcher_url: Url,
    /// The ACME CA this server's certificates are ordered from. A new server
    /// gets
    /// [`DEFAULT_CERTIFICATE_AUTHORITY`](ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY).
    pub certificate_authority: CertificateAuthority,
    /// When the user wants this server run. Enrolment gives a new server
    /// [`RunPolicy::WhileOpen`] when no other server's policy wants it
    /// running, and [`RunPolicy::Off`] otherwise. It says nothing about whether
    /// a run is up, which is live state and never stored.
    pub run_policy: RunPolicy,
}

impl ServerRecord {
    /// The CA a new server's certificates are ordered from: Let's Encrypt's
    /// production CA, whose certificates browsers trust.
    ///
    /// Every server's domain is under its relay's domain, so all of a relay's
    /// servers share one registered domain, and with it Let's Encrypt's limit
    /// of 50 certificates per registered domain per week.
    pub const DEFAULT_CERTIFICATE_AUTHORITY: CertificateAuthority =
        CertificateAuthority::LetsEncrypt;

    /// The server's domain, `<tunnel name>.<relay domain>`: its identity in
    /// the registry, its issuer, and the name of its data folder.
    #[must_use]
    pub fn domain(&self) -> String {
        format!("{}.{}", self.tunnel_name, self.public_settings.domain)
    }

    /// The folder the server runs from, `<data_root>/servers/<domain>/`, which
    /// holds its databases. Only the path: nothing is created here. The
    /// domain is a tunnel name and a relay domain, both DNS labels, so it
    /// can't climb out of `servers/`.
    #[must_use]
    pub fn server_dir(&self, data_root: &Path) -> PathBuf {
        data_root.join(SERVERS_DIR_NAME).join(self.domain())
    }

    /// The folder the server's certificates and their keys are cached in,
    /// `<data_root>/servers/<domain>/certificates/`, inside its
    /// [`server_dir`](Self::server_dir), so removing the server deletes them.
    /// Only the path: nothing is created here.
    #[must_use]
    fn certificate_dir(&self, data_root: &Path) -> PathBuf {
        self.server_dir(data_root).join(CERTIFICATES_DIR_NAME)
    }

    /// Where a run of the server orders and caches its certificate: from its
    /// [`certificate_authority`](Self::certificate_authority), cached in
    /// `certificates/` in its [`server_dir`](Self::server_dir), so removing
    /// the server deletes them, and ordered with the install's ACME account, cached in
    /// `<data_root>/acme-account/`, which removing a server leaves. Only the
    /// paths: nothing is created here.
    #[must_use]
    pub fn device_certificate_config(&self, data_root: &Path) -> DeviceCertificateConfig {
        DeviceCertificateConfig {
            certificate_authority: self.certificate_authority,
            certificate_dir: self.certificate_dir(data_root),
            acme_account_dir: data_root.join(ACME_ACCOUNT_DIR_NAME),
        }
    }

    /// Whether a run of the server built from `other` could differ from one
    /// built from `self`: whether any field a run reads differs.
    ///
    /// A run reads every field but two: the launcher URL, which only the base
    /// reads to open apps, and the run policy, which says when the server
    /// runs, not how, and reaches `UnitRunner` on its own. The certificate
    /// authority is a run's: it is where the server's certificates come from.
    #[must_use]
    pub fn run_inputs_differ(&self, other: &Self) -> bool {
        // Destructured, so a new field needs a decision here.
        let Self {
            relay,
            tunnel_name,
            token,
            public_settings,
            launcher_url: _,
            certificate_authority,
            run_policy: _,
        } = self;
        *relay != other.relay
            || *tunnel_name != other.tunnel_name
            || *token != other.token
            || *public_settings != other.public_settings
            || *certificate_authority != other.certificate_authority
    }
}

/// The kind of relay a server's tunnel runs through, as the record stores
/// it.
///
/// Serialised as `{"kind": "wildflowerOfficial"}`,
/// `{"kind": "selfHostedWildflower", "baseUrl"}` or `{"kind": "rathole"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RelayKind {
    /// The relay Wildflower runs, at
    /// [`WILDFLOWER_BASE_URL`](Self::WILDFLOWER_BASE_URL).
    WildflowerOfficial,
    /// A Wildflower relay someone else runs, entered by the base URL of its
    /// Wildflower relay site. What its rathole client dials comes from its
    /// `GET /rathole`, kept in the record's `public_settings`.
    SelfHostedWildflower {
        /// The relay's Wildflower relay site, where it serves `GET /rathole`
        /// and `GET /me`.
        base_url: Url,
    },
    /// A rathole server with no Wildflower relay site, whose settings
    /// were entered by hand. They are kept only in the record's
    /// `public_settings`.
    Rathole,
}

impl RelayKind {
    /// The Wildflower relay site of the relay Wildflower runs.
    pub const WILDFLOWER_BASE_URL: &'static str = "https://relay.wildflowerhealth.io";

    /// [`WILDFLOWER_BASE_URL`](Self::WILDFLOWER_BASE_URL) as a [`Url`].
    ///
    /// # Panics
    ///
    /// Never: the constant is an absolute URL, which a test checks.
    #[must_use]
    pub fn wildflower_base_url() -> Url {
        Url::parse(Self::WILDFLOWER_BASE_URL).expect("WILDFLOWER_BASE_URL is an absolute URL")
    }

    /// The relay's Wildflower relay site, where it serves `GET /rathole` and
    /// `GET /me`: [`WILDFLOWER_BASE_URL`](Self::WILDFLOWER_BASE_URL) for
    /// [`RelayKind::WildflowerOfficial`], the entered `base_url` for
    /// [`RelayKind::SelfHostedWildflower`], and none for
    /// [`RelayKind::Rathole`].
    #[must_use]
    pub fn site_base_url(&self) -> Option<Url> {
        match self {
            Self::WildflowerOfficial => Some(Self::wildflower_base_url()),
            Self::SelfHostedWildflower { base_url } => Some(base_url.clone()),
            Self::Rathole => None,
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

    /// The launcher the fixtures' records have, and the default launcher the
    /// tests give [`add_server`](crate::add_server).
    pub(crate) fn launcher_url() -> Url {
        Url::parse("https://wildflowerhealth.io/app").unwrap()
    }

    pub(crate) fn official_record(tunnel_name: &str) -> ServerRecord {
        ServerRecord {
            relay: RelayKind::WildflowerOfficial,
            tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
            token: TunnelToken::new(TOKEN),
            public_settings: PublicRatholeSettings {
                remote_addr: "relay.wildflowerhealth.io:2333".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
                domain: "relay.wildflowerhealth.io".to_owned(),
            },
            launcher_url: launcher_url(),
            certificate_authority: CertificateAuthority::LetsEncrypt,
            run_policy: RunPolicy::Off,
        }
    }

    pub(crate) fn self_hosted_record(tunnel_name: &str) -> ServerRecord {
        ServerRecord {
            relay: RelayKind::SelfHostedWildflower {
                base_url: Url::parse("https://relay.example.com").unwrap(),
            },
            tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
            token: TunnelToken::new(TOKEN),
            public_settings: PublicRatholeSettings {
                remote_addr: "relay.example.com:2333".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                domain: "relay.example.com".to_owned(),
            },
            launcher_url: Url::parse("https://launcher.example.com/").unwrap(),
            certificate_authority: CertificateAuthority::LetsEncryptStaging,
            run_policy: RunPolicy::Off,
        }
    }

    #[test]
    fn a_relay_s_site_is_the_official_one_the_entered_one_or_none() {
        assert_eq!(
            RelayKind::WildflowerOfficial
                .site_base_url()
                .unwrap()
                .as_str(),
            "https://relay.wildflowerhealth.io/"
        );
        assert_eq!(
            self_hosted_record("lab")
                .relay
                .site_base_url()
                .unwrap()
                .as_str(),
            "https://relay.example.com/"
        );
        assert_eq!(RelayKind::Rathole.site_base_url(), None);
    }

    #[test]
    fn a_relay_serialises_camel_case_by_kind() {
        for (relay, json) in [
            (
                RelayKind::WildflowerOfficial,
                serde_json::json!({"kind": "wildflowerOfficial"}),
            ),
            (
                self_hosted_record("lab").relay,
                serde_json::json!({"kind": "selfHostedWildflower", "baseUrl": "https://relay.example.com/"}),
            ),
            (RelayKind::Rathole, serde_json::json!({"kind": "rathole"})),
        ] {
            assert_eq!(serde_json::to_value(&relay).unwrap(), json);
            assert_eq!(serde_json::from_value::<RelayKind>(json).unwrap(), relay);
        }
        assert!(serde_json::from_value::<RelayKind>(
            serde_json::json!({"kind": "selfHostedWildflower", "base_url": "https://relay.example.com/"})
        )
        .is_err());
    }

    #[test]
    fn only_the_launcher_and_the_run_policy_are_not_run_inputs() {
        let ruth = official_record("ruth");
        for not_read_by_a_run in [
            ServerRecord {
                launcher_url: Url::parse("http://localhost:5200/app").unwrap(),
                ..ruth.clone()
            },
            ServerRecord {
                run_policy: RunPolicy::Always,
                ..ruth.clone()
            },
        ] {
            assert!(!ruth.run_inputs_differ(&not_read_by_a_run));
        }
        let mut other_public_settings = ruth.public_settings.clone();
        other_public_settings.public_key =
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned();
        for read_by_a_run in [
            ServerRecord {
                certificate_authority: CertificateAuthority::LetsEncryptStaging,
                ..ruth.clone()
            },
            ServerRecord {
                token: TunnelToken::new("another-token"),
                ..ruth.clone()
            },
            ServerRecord {
                public_settings: other_public_settings,
                ..ruth.clone()
            },
            ServerRecord {
                relay: RelayKind::Rathole,
                ..ruth.clone()
            },
            official_record("lab"),
        ] {
            assert!(ruth.run_inputs_differ(&read_by_a_run));
        }
    }

    #[test]
    fn domain_is_the_tunnel_name_under_the_relay_domain() {
        assert_eq!(
            official_record("ruth").domain(),
            "ruth.relay.wildflowerhealth.io"
        );
        assert_eq!(self_hosted_record("lab").domain(), "lab.relay.example.com");
    }

    #[test]
    fn a_server_s_folder_is_its_domain_under_servers() {
        let data_root = Path::new("/data/root");
        assert_eq!(
            official_record("ruth").server_dir(data_root),
            Path::new("/data/root/servers/ruth.relay.wildflowerhealth.io")
        );
        assert_eq!(
            self_hosted_record("lab").server_dir(data_root),
            Path::new("/data/root/servers/lab.relay.example.com")
        );
    }

    /// A server's certificates come from the CA its record names, are cached
    /// in its own folder, and are ordered with the install's one account.
    #[test]
    fn a_server_s_certificate_config_is_its_ca_its_folder_and_the_install_s_account() {
        let data_root = Path::new("/data/root");
        assert_eq!(
            official_record("ruth").device_certificate_config(data_root),
            DeviceCertificateConfig {
                certificate_authority: CertificateAuthority::LetsEncrypt,
                certificate_dir: PathBuf::from(
                    "/data/root/servers/ruth.relay.wildflowerhealth.io/certificates"
                ),
                acme_account_dir: PathBuf::from("/data/root/acme-account"),
            }
        );
        assert_eq!(
            self_hosted_record("lab").device_certificate_config(data_root),
            DeviceCertificateConfig {
                certificate_authority: CertificateAuthority::LetsEncryptStaging,
                certificate_dir: PathBuf::from(
                    "/data/root/servers/lab.relay.example.com/certificates"
                ),
                acme_account_dir: PathBuf::from("/data/root/acme-account"),
            }
        );
    }

    #[test]
    fn debug_redacts_the_token() {
        let rendered = format!("{:?}", official_record("ruth"));
        assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
        assert!(
            rendered.contains(TunnelToken::REDACTED),
            "no redaction marker: {rendered}"
        );
        assert!(rendered.contains("ruth"), "tunnel name hidden: {rendered}");
    }

    #[test]
    fn serialising_a_record_redacts_the_token() {
        let rendered = serde_json::to_string(&self_hosted_record("lab")).unwrap();
        assert!(!rendered.contains(TOKEN), "token leaked: {rendered}");
        assert!(
            rendered.contains(r#""token":"<redacted>""#),
            "no redaction marker: {rendered}"
        );
        assert!(
            rendered.contains(r#""tunnelName":"lab""#),
            "not camelCase: {rendered}"
        );
    }
}
