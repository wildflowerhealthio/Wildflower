//! Enrolment: adding a server from a relay, a tunnel name and its token, and
//! re-entering a server's token.
//!
//! A Wildflower relay (the official one, or a self-hosted one entered by the
//! base URL of its relay site) is asked the same way both times, through a
//! [`RelayClient`] built for its base URL. Its `GET /rathole` is fetched and
//! checked, then compared with the [`RelayIdentity`] expected of it: the
//! user's pin when a server is added, and the identity the server was added
//! with when its token is re-entered. Then a `GET /me` signed with the token
//! confirms the relay holds that tunnel name and token, and that it reaches
//! the tunnel at `<tunnel name>.<relay domain>`. Only then is the registry
//! written. The response to `GET /rathole` becomes the record's
//! `public_settings`; a pin is checked and never stored.
//!
//! A rathole relay, a rathole server with no Wildflower relay site, is
//! entered as its settings. They get the same checks a `GET /rathole` response
//! does and become the record's `public_settings`; no request is made, and the
//! tunnel coming up is the check. Its token is replaced without a request too.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rathole_settings_rust::{
    parse_public_addr, NoisePattern, PublicRatholeSettings, RelayDomain, Transport, TunnelHost,
    TunnelName,
};
use serde::Deserialize;
use url::Url;

use crate::domain::{EnrolmentError, RegistryError, RelayKind, ServerRecord, TunnelToken};
use crate::ports::{RelayClient, ServerRegistry};

/// The relay as the user entered it.
///
/// Deserialised from `{"kind": "wildflowerOfficial"}`,
/// `{"kind": "selfHostedWildflower", "baseUrl", "pin"?}` or
/// `{"kind": "rathole", "remoteAddr", "publicKey", "domain"}`, the pin being
/// `{"remoteAddr", "publicKey"}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EnteredRelay {
    /// The relay Wildflower runs.
    WildflowerOfficial,
    /// A Wildflower relay someone else runs, with its Wildflower relay site
    /// at `base_url`, which needn't share a host with the domain its
    /// `GET /rathole` serves.
    SelfHostedWildflower {
        /// As entered. [`add_server`] checks it is an `https` URL with a
        /// host and no credentials, query or fragment, so a bad one is an
        /// [`EnrolmentError::InvalidRelaySetting`] rather than an argument
        /// that fails to decode.
        base_url: String,
        /// The identity its `GET /rathole` must serve, checked and not
        /// stored.
        #[serde(default)]
        pin: Option<RelayIdentity>,
    },
    /// A rathole server with no Wildflower relay site, entered as the
    /// settings its `GET /rathole` would serve. The transport and noise
    /// pattern are the only ones a device runs.
    Rathole {
        #[serde(flatten)]
        identity: RelayIdentity,
        /// The relay domain the server's domain ends in.
        domain: String,
    },
}

/// What tells one relay from another, as a rathole client sees it: the
/// address it dials and the noise key it expects there. Entered by hand as a
/// pin or for a rathole relay, and taken from a record's `public_settings`
/// when its token is re-entered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayIdentity {
    /// The `host:port` the rathole client dials. Compared ignoring ASCII
    /// case, as [`parse_public_addr`] folds it.
    pub remote_addr: String,
    /// The relay's X25519 noise public key, base64.
    pub public_key: String,
}

impl RelayIdentity {
    fn of(public_settings: &PublicRatholeSettings) -> Self {
        Self {
            remote_addr: public_settings.remote_addr.clone(),
            public_key: public_settings.public_key.clone(),
        }
    }

    /// The first setting `public_settings` serves differently from this
    /// identity: its name, as the command's arguments name it, this
    /// identity's value and the served one.
    fn first_difference(
        &self,
        public_settings: &PublicRatholeSettings,
    ) -> Option<(&'static str, String, String)> {
        if !self
            .remote_addr
            .eq_ignore_ascii_case(&public_settings.remote_addr)
        {
            return Some((
                "remoteAddr",
                self.remote_addr.clone(),
                public_settings.remote_addr.clone(),
            ));
        }
        if self.public_key != public_settings.public_key {
            return Some((
                "publicKey",
                self.public_key.clone(),
                public_settings.public_key.clone(),
            ));
        }
        None
    }
}

/// Enrol `tunnel_name` at `relay` with `token` and register the server, with
/// the default launcher and production certificates. The server is set
/// [`running`](ServerRecord::running) when no registered server is, so the
/// first server added is the one the host starts; a later one isn't.
///
/// `relay_client` builds the [`RelayClient`] for a Wildflower relay from its
/// base URL; it is called once for an official or self-hosted Wildflower
/// relay, and never for [`EnteredRelay::Rathole`].
///
/// # Errors
///
/// [`EnrolmentError::InvalidRelaySetting`] for an entered base URL or rathole
/// relay setting, [`EnrolmentError::PinMismatch`] when the relay doesn't serve
/// the pinned identity, any [`EnrolmentError`] from `relay_client` or the
/// relay's site, with nothing written, or [`EnrolmentError::Registry`]; a
/// server with the same domain is [`RegistryError::AlreadyRegistered`].
pub async fn add_server<S: RelayClient>(
    registry: Arc<dyn ServerRegistry>,
    relay: EnteredRelay,
    tunnel_name: TunnelName,
    token: TunnelToken,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<ServerRecord, EnrolmentError> {
    let (relay, public_settings) = match relay {
        EnteredRelay::WildflowerOfficial => {
            let relay_client = relay_client(RelayKind::wildflower_base_url())?;
            let public_settings =
                confirmed_public_settings(&relay_client, &tunnel_name, &token, |_| Ok(())).await?;
            (RelayKind::WildflowerOfficial, public_settings)
        }
        EnteredRelay::SelfHostedWildflower { base_url, pin } => {
            let base_url = parse_base_url(&base_url)?;
            let relay_client = relay_client(base_url.clone())?;
            let public_settings =
                confirmed_public_settings(&relay_client, &tunnel_name, &token, |served| {
                    let Some(pin) = &pin else { return Ok(()) };
                    if let Some((setting, pinned, served)) = pin.first_difference(served) {
                        return Err(EnrolmentError::PinMismatch {
                            setting,
                            pinned,
                            served,
                        });
                    }
                    Ok(())
                })
                .await?;
            (
                RelayKind::SelfHostedWildflower { base_url },
                public_settings,
            )
        }
        EnteredRelay::Rathole { identity, domain } => {
            let RelayIdentity {
                remote_addr,
                public_key,
            } = identity;
            let public_settings = checked_relay_settings(PublicRatholeSettings {
                remote_addr,
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key,
                domain,
            })
            .map_err(|problem| EnrolmentError::InvalidRelaySetting {
                setting: problem.setting,
                reason: problem.reason,
            })?;
            (RelayKind::Rathole, public_settings)
        }
    };
    let record = run_blocking(registry, move |registry| {
        let running = !registry.read_all()?.iter().any(|server| server.running);
        let record = ServerRecord {
            relay,
            tunnel_name,
            token,
            public_settings,
            launcher_url: ServerRecord::default_launcher_url(),
            staging_certificates: false,
            running,
        };
        registry.insert(record.clone())?;
        Ok(record)
    })
    .await?;
    Ok(record)
}

/// Replace the token of the server with `domain` by `token`; everything else
/// is kept.
///
/// For a Wildflower relay, the token is first checked with it the way
/// [`add_server`] does, through the [`RelayClient`] `relay_client` builds from
/// its base URL. The relay's identity was pinned when the server was added:
/// its current `GET /rathole` must serve the same domain, remote address and
/// noise key as the record's `public_settings`, before the signed `GET /me`
/// is sent. The record then takes that response as its `public_settings`. A
/// [`RelayKind::Rathole`] server's token is replaced without a request, and
/// `relay_client` is never called.
///
/// # Errors
///
/// [`RegistryError::NotRegistered`] when no server has `domain`, checked
/// before the relay is asked; [`EnrolmentError::DomainChanged`] when the relay
/// now serves another domain; [`EnrolmentError::RelayIdentityChanged`] when
/// it serves another remote address or noise key; any other
/// [`EnrolmentError`] from `relay_client` or the relay's site; or a registry
/// failure. Nothing is written on any of them.
pub async fn set_server_credentials<S: RelayClient>(
    registry: Arc<dyn ServerRegistry>,
    domain: &str,
    token: TunnelToken,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<ServerRecord, EnrolmentError> {
    let wanted_domain = domain.to_owned();
    let registered = run_blocking(Arc::clone(&registry), move |registry| {
        registry
            .read_all()?
            .into_iter()
            .find(|record| record.domain() == wanted_domain)
            .ok_or(RegistryError::NotRegistered {
                domain: wanted_domain,
            })
    })
    .await?;
    let public_settings = match registered.relay.site_base_url() {
        None => registered.public_settings.clone(),
        Some(relay_base) => {
            let relay_client = relay_client(relay_base)?;
            let registered_settings = &registered.public_settings;
            confirmed_public_settings(&relay_client, &registered.tunnel_name, &token, |served| {
                if served.domain != registered_settings.domain {
                    return Err(EnrolmentError::DomainChanged {
                        registered: registered_settings.domain.clone(),
                        served: served.domain.clone(),
                    });
                }
                let registered_identity = RelayIdentity::of(registered_settings);
                if let Some((setting, registered, served)) =
                    registered_identity.first_difference(served)
                {
                    return Err(EnrolmentError::RelayIdentityChanged {
                        setting,
                        registered,
                        served,
                    });
                }
                Ok(())
            })
            .await?
        }
    };
    let record = ServerRecord {
        token,
        public_settings,
        ..registered
    };
    let updated = record.clone();
    run_blocking(registry, move |registry| registry.update(updated)).await?;
    Ok(record)
}

/// An entered self-hosted relay's base URL, if a relay site can be asked
/// there: an absolute `https` URL with a host, and no credentials, query or
/// fragment, since the signed requests are made under it.
///
/// # Errors
///
/// [`EnrolmentError::InvalidRelaySetting`] for `baseUrl`, saying why.
fn parse_base_url(entered: &str) -> Result<Url, EnrolmentError> {
    let invalid = |reason: String| EnrolmentError::InvalidRelaySetting {
        setting: "baseUrl",
        reason,
    };
    let base_url = Url::parse(entered)
        .map_err(|error| invalid(format!("{entered:?} is not a URL: {error}")))?;
    if base_url.scheme() != "https" {
        return Err(invalid(format!("{entered:?} is not an https URL")));
    }
    if base_url.host_str().is_none_or(str::is_empty) {
        return Err(invalid(format!("{entered:?} has no host")));
    }
    if !base_url.username().is_empty() || base_url.password().is_some() {
        return Err(invalid(format!("{entered:?} holds credentials")));
    }
    if base_url.query().is_some() || base_url.fragment().is_some() {
        return Err(invalid(format!("{entered:?} has a query or fragment")));
    }
    Ok(base_url)
}

/// The relay's `GET /rathole`, checked and passed to `expect`, which refuses
/// it if it isn't the relay expected; then a signed `GET /me` confirms it
/// holds `tunnel_name` and `token`. `expect` runs before the signed request
/// is sent.
async fn confirmed_public_settings(
    relay_client: &impl RelayClient,
    tunnel_name: &TunnelName,
    token: &TunnelToken,
    expect: impl FnOnce(&PublicRatholeSettings) -> Result<(), EnrolmentError>,
) -> Result<PublicRatholeSettings, EnrolmentError> {
    let public_settings =
        checked_relay_settings(relay_client.public_settings().await?).map_err(|problem| {
            EnrolmentError::BadRelayResponse {
                path: "/rathole",
                reason: format!("{} {}", problem.setting, problem.reason),
            }
        })?;
    expect(&public_settings)?;
    let tunnel_host = relay_client.tunnel_host(tunnel_name, token).await?;
    check_tunnel_host(&tunnel_host, tunnel_name, &public_settings.domain)?;
    Ok(public_settings)
}

/// A relay setting a server can't be built on: the `setting`, named as the
/// command's arguments name it, and why.
struct RelaySettingProblem {
    setting: &'static str,
    reason: String,
}

/// Relay settings, served by `GET /rathole` or entered by hand, if a server
/// can be built on them: the `domain` is a [`RelayDomain`], since it ends the
/// server's domain and folder name, the `remote_addr` a `host:port` as
/// [`parse_public_addr`] reads one (and is case-folded by it), and the
/// `public_key` 32 bytes of base64, as `rathole --genkey` prints an X25519
/// key. These are the checks the relay applies to its own settings.
fn checked_relay_settings(
    public_settings: PublicRatholeSettings,
) -> Result<PublicRatholeSettings, RelaySettingProblem> {
    if let Err(error) = RelayDomain::parse(public_settings.domain.as_str()) {
        return Err(RelaySettingProblem {
            setting: "domain",
            reason: format!("{:?} is not a lowercase DNS name", error.domain),
        });
    }
    let remote_addr =
        parse_public_addr(&public_settings.remote_addr).map_err(|error| RelaySettingProblem {
            setting: "remoteAddr",
            reason: format!(
                "{:?} is not a usable host:port: {error}",
                public_settings.remote_addr
            ),
        })?;
    let public_key = &public_settings.public_key;
    let key_is_valid = BASE64
        .decode(public_key)
        .is_ok_and(|bytes| bytes.len() == 32);
    if !key_is_valid {
        return Err(RelaySettingProblem {
            setting: "publicKey",
            reason: format!("{public_key:?} is not 32 bytes of base64"),
        });
    }
    Ok(PublicRatholeSettings {
        remote_addr,
        ..public_settings
    })
}

/// Whether `GET /me` named the tunnel that signed, at `<tunnel name>.<domain>`
/// for the `domain` `GET /rathole` served.
fn check_tunnel_host(
    tunnel_host: &TunnelHost,
    tunnel_name: &TunnelName,
    domain: &str,
) -> Result<(), EnrolmentError> {
    let expected_public_host = format!("{tunnel_name}.{domain}");
    if tunnel_host.tunnel_name != *tunnel_name || tunnel_host.public_host != expected_public_host {
        return Err(EnrolmentError::BadRelayResponse {
            path: "/me",
            reason: format!(
                "it names {:?} at {:?}, not {:?} at {expected_public_host:?}",
                tunnel_host.tunnel_name.as_str(),
                tunnel_host.public_host,
                tunnel_name.as_str()
            ),
        });
    }
    Ok(())
}

/// Run `operation` on the registry on a blocking thread, as the
/// [`ServerRegistry`] port asks of an async caller.
async fn run_blocking<T: Send + 'static>(
    registry: Arc<dyn ServerRegistry>,
    operation: impl FnOnce(&dyn ServerRegistry) -> Result<T, RegistryError> + Send + 'static,
) -> Result<T, RegistryError> {
    tokio::task::spawn_blocking(move || operation(registry.as_ref()))
        .await
        .map_err(|error| RegistryError::storage("running a registry operation", error))?
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::domain::fixtures::{official_record, TOKEN};
    use crate::JsonServerRegistry;

    const RELAY_DOMAIN: &str = "relay.example.com";
    const PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";

    fn served_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: format!("{RELAY_DOMAIN}:2333"),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: PUBLIC_KEY.to_owned(),
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    /// A relay client that serves `public_settings` (or is unreachable when
    /// there are none) and accepts `ruth` with [`TOKEN`]. Clones share their
    /// counts, so a test keeps one while enrolment gets another.
    #[derive(Clone)]
    struct FakeRelayClient {
        public_settings: Option<PublicRatholeSettings>,
        /// What `GET /me` answers, in place of the signing tunnel's host.
        tunnel_host: Option<TunnelHost>,
        /// How many `GET /me` requests were made.
        tunnel_host_fetches: Arc<AtomicUsize>,
        /// The base URL of every relay client built for enrolment.
        built_for: Arc<Mutex<Vec<Url>>>,
    }

    impl FakeRelayClient {
        fn serving(public_settings: PublicRatholeSettings) -> Self {
            Self {
                public_settings: Some(public_settings),
                tunnel_host: None,
                tunnel_host_fetches: Arc::default(),
                built_for: Arc::default(),
            }
        }

        /// What enrolment builds its relay client with: this fake, for any base
        /// URL.
        fn builder(&self) -> impl FnOnce(Url) -> Result<Self, EnrolmentError> + '_ {
            |relay_base| {
                self.built_for.lock().unwrap().push(relay_base);
                Ok(self.clone())
            }
        }

        fn built_for(&self) -> Vec<Url> {
            self.built_for.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl RelayClient for FakeRelayClient {
        async fn public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError> {
            self.public_settings
                .clone()
                .ok_or_else(|| EnrolmentError::RelayUnreachable {
                    relay_base: Url::parse(&format!("https://{RELAY_DOMAIN}")).unwrap(),
                    source: "connection refused".into(),
                })
        }

        async fn tunnel_host(
            &self,
            tunnel_name: &TunnelName,
            token: &TunnelToken,
        ) -> Result<TunnelHost, EnrolmentError> {
            self.tunnel_host_fetches.fetch_add(1, Ordering::SeqCst);
            if tunnel_name.as_str() != "ruth" || token.expose() != TOKEN {
                return Err(EnrolmentError::SignedRequestRejected {
                    tunnel_name: tunnel_name.clone(),
                });
            }
            let domain = &self.public_settings.as_ref().unwrap().domain;
            Ok(self.tunnel_host.clone().unwrap_or_else(|| TunnelHost {
                tunnel_name: tunnel_name.clone(),
                public_host: format!("{tunnel_name}.{domain}"),
            }))
        }
    }

    /// A builder for relays that have no relay client to build.
    fn no_client(relay_base: Url) -> Result<FakeRelayClient, EnrolmentError> {
        panic!("built a relay client for {relay_base}")
    }

    fn registry() -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = Arc::new(JsonServerRegistry::in_data_root(data_root.path()));
        (data_root, registry)
    }

    fn self_hosted_base_url() -> Url {
        Url::parse(&format!("https://{RELAY_DOMAIN}")).unwrap()
    }

    fn self_hosted_relay(pin: Option<RelayIdentity>) -> EnteredRelay {
        EnteredRelay::SelfHostedWildflower {
            base_url: format!("https://{RELAY_DOMAIN}"),
            pin,
        }
    }

    fn rathole_relay() -> EnteredRelay {
        EnteredRelay::Rathole {
            identity: RelayIdentity {
                remote_addr: format!("{RELAY_DOMAIN}:2333"),
                public_key: PUBLIC_KEY.to_owned(),
            },
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    fn ruth() -> TunnelName {
        TunnelName::parse("ruth").unwrap()
    }

    async fn add(
        registry: &Arc<dyn ServerRegistry>,
        relay_client: &FakeRelayClient,
        relay: EnteredRelay,
        token: &str,
    ) -> Result<ServerRecord, EnrolmentError> {
        add_server(
            Arc::clone(registry),
            relay,
            ruth(),
            TunnelToken::new(token),
            relay_client.builder(),
        )
        .await
    }

    #[tokio::test]
    async fn adds_a_server_from_the_relay_s_settings() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::SelfHostedWildflower {
                    base_url: self_hosted_base_url()
                },
                tunnel_name: ruth(),
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                launcher_url: ServerRecord::default_launcher_url(),
                staging_certificates: false,
                running: true,
            }
        );
        assert_eq!(record.domain(), "ruth.relay.example.com");
        assert_eq!(relay_client.built_for(), vec![self_hosted_base_url()]);
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn the_official_relay_is_asked_at_its_own_site() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            TOKEN,
        )
        .await
        .unwrap();

        assert_eq!(record.relay, RelayKind::WildflowerOfficial);
        assert_eq!(
            relay_client.built_for(),
            vec![RelayKind::wildflower_base_url()]
        );
    }

    /// A self-hosted relay's site host and the domain it serves tunnels
    /// under are independent: its relay site may live anywhere.
    #[tokio::test]
    async fn a_self_hosted_relay_s_site_need_not_be_at_the_domain_it_serves() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(PublicRatholeSettings {
            domain: "tunnels.example.org".to_owned(),
            ..served_settings()
        });

        let record = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert_eq!(record.domain(), "ruth.tunnels.example.org");
        assert_eq!(
            record.relay,
            RelayKind::SelfHostedWildflower {
                base_url: self_hosted_base_url()
            }
        );
    }

    #[tokio::test]
    async fn a_matching_pin_is_accepted_and_not_stored() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let relay_pin = RelayIdentity {
            remote_addr: "Relay.Example.com:2333".to_owned(),
            public_key: PUBLIC_KEY.to_owned(),
        };

        let record = add(
            &registry,
            &relay_client,
            self_hosted_relay(Some(relay_pin)),
            TOKEN,
        )
        .await
        .unwrap();

        assert_eq!(record.public_settings, served_settings());
        assert_eq!(
            record.relay,
            RelayKind::SelfHostedWildflower {
                base_url: self_hosted_base_url()
            }
        );
    }

    #[tokio::test]
    async fn a_pin_the_relay_does_not_serve_fails_before_the_signed_request() {
        for (relay_pin, mismatched) in [
            (
                RelayIdentity {
                    remote_addr: "relay.example.com:7000".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                },
                "remoteAddr",
            ),
            (
                RelayIdentity {
                    remote_addr: served_settings().remote_addr,
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                },
                "publicKey",
            ),
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient::serving(served_settings());
            let result = add(
                &registry,
                &relay_client,
                self_hosted_relay(Some(relay_pin)),
                TOKEN,
            )
            .await;
            assert!(
                matches!(result, Err(EnrolmentError::PinMismatch { setting, .. }) if setting == mismatched),
                "{mismatched}"
            );
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn an_unreachable_relay_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient {
            public_settings: None,
            ..FakeRelayClient::serving(served_settings())
        };
        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_site_that_cannot_be_built_writes_nothing() {
        let (_data_root, registry) = registry();
        let result = add_server(
            Arc::clone(&registry),
            self_hosted_relay(None),
            ruth(),
            TunnelToken::new(TOKEN),
            |relay_base| -> Result<FakeRelayClient, _> {
                Err(EnrolmentError::RelayUnreachable {
                    relay_base,
                    source: "no TLS backend".into(),
                })
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_rejected_token_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), "not-the-token").await,
            Err(EnrolmentError::SignedRequestRejected { tunnel_name }) if tunnel_name == ruth()
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    /// Relay settings a server can't be built on, each with the setting it
    /// breaks.
    fn bad_settings() -> Vec<(&'static str, PublicRatholeSettings)> {
        let with = |setting: &'static str, value: &str| {
            let mut public_settings = served_settings();
            match setting {
                "domain" => public_settings.domain = value.to_owned(),
                "remoteAddr" => public_settings.remote_addr = value.to_owned(),
                _ => public_settings.public_key = value.to_owned(),
            }
            (setting, public_settings)
        };
        vec![
            with("domain", "Relay.example.com"),
            with("domain", "../relay"),
            with("domain", ""),
            with("remoteAddr", "relay.example.com"),
            with("remoteAddr", "relay.example.com:0"),
            with("remoteAddr", ":2333"),
            with("remoteAddr", "relay example.com:2333"),
            with("remoteAddr", "a:b:2333"),
            with("remoteAddr", "[bad:2333"),
            with("remoteAddr", "\"relay\".example.com:2333"),
            with("remoteAddr", "relay.example.com:2333\n"),
            with("publicKey", ""),
            with("publicKey", "not base64!"),
            with("publicKey", "AAAA"),
        ]
    }

    #[tokio::test]
    async fn rathole_settings_a_server_cannot_be_built_on_are_a_bad_response() {
        for (setting, public_settings) in bad_settings() {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient::serving(public_settings.clone());
            let result = add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await;
            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::BadRelayResponse {
                        path: "/rathole",
                        reason,
                    }) if reason.starts_with(setting)
                ),
                "{public_settings:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_me_response_naming_another_tunnel_or_host_is_a_bad_response() {
        for tunnel_host in [
            TunnelHost {
                tunnel_name: TunnelName::parse("someone-else").unwrap(),
                public_host: "ruth.relay.example.com".to_owned(),
            },
            TunnelHost {
                tunnel_name: TunnelName::parse("ruth").unwrap(),
                public_host: "ruth.elsewhere.example.com".to_owned(),
            },
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient {
                tunnel_host: Some(tunnel_host.clone()),
                ..FakeRelayClient::serving(served_settings())
            };
            assert!(
                matches!(
                    add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
                    Err(EnrolmentError::BadRelayResponse { path: "/me", .. })
                ),
                "{tunnel_host:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn adding_a_server_that_exists_is_refused() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let existing = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
            Err(EnrolmentError::Registry(RegistryError::AlreadyRegistered { domain }))
                if domain == "ruth.relay.example.com"
        ));
        assert_eq!(registry.read_all().unwrap(), vec![existing]);
    }

    /// The first server added is the one the host starts; a later one isn't.
    #[tokio::test]
    async fn only_the_first_server_added_is_set_running() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let first = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();
        let second = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            TunnelName::parse("lab").unwrap(),
            TunnelToken::new("any-token"),
            no_client,
        )
        .await
        .unwrap();

        assert!(first.running);
        assert!(!second.running);
        assert_eq!(registry.read_all().unwrap(), vec![first, second]);
    }

    /// Servers registered with none set running don't stop the next one
    /// added from being set.
    #[tokio::test]
    async fn a_server_added_while_none_is_running_is_set_running() {
        let (_data_root, registry) = registry();
        let stopped = official_record("lab");
        assert!(!stopped.running);
        registry.insert(stopped.clone()).unwrap();
        let relay_client = FakeRelayClient::serving(served_settings());

        let added = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert!(added.running);
        assert_eq!(registry.read_all().unwrap(), vec![stopped, added]);
    }

    #[tokio::test]
    async fn a_rathole_relay_is_added_from_its_entered_settings_without_a_request() {
        let (_data_root, registry) = registry();

        let record = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            ruth(),
            TunnelToken::new("any-token"),
            no_client,
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::Rathole,
                tunnel_name: ruth(),
                token: TunnelToken::new("any-token"),
                public_settings: served_settings(),
                launcher_url: ServerRecord::default_launcher_url(),
                staging_certificates: false,
                running: true,
            }
        );
        assert_eq!(record.domain(), "ruth.relay.example.com");
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// A rathole relay's entered settings get the checks a `GET /rathole`
    /// response does.
    #[tokio::test]
    async fn a_rathole_relay_s_invalid_setting_is_named_and_writes_nothing() {
        for (setting, public_settings) in bad_settings() {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                EnteredRelay::Rathole {
                    identity: RelayIdentity::of(&public_settings),
                    domain: public_settings.domain.clone(),
                },
                ruth(),
                TunnelToken::new(TOKEN),
                no_client,
            )
            .await;
            assert!(
                matches!(&result, Err(EnrolmentError::InvalidRelaySetting { setting: named, .. }) if *named == setting),
                "{public_settings:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[test]
    fn an_entered_relay_decodes_from_camel_case_json() {
        for (json, relay) in [
            (
                serde_json::json!({"kind": "wildflowerOfficial"}),
                EnteredRelay::WildflowerOfficial,
            ),
            (
                serde_json::json!({"kind": "selfHostedWildflower", "baseUrl": "https://relay.example.com"}),
                self_hosted_relay(None),
            ),
            (
                serde_json::json!({
                    "kind": "selfHostedWildflower",
                    "baseUrl": "https://relay.example.com",
                    "pin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY},
                }),
                self_hosted_relay(Some(RelayIdentity {
                    remote_addr: "relay.example.com:2333".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                })),
            ),
            (
                serde_json::json!({
                    "kind": "rathole",
                    "remoteAddr": "relay.example.com:2333",
                    "publicKey": PUBLIC_KEY,
                    "domain": RELAY_DOMAIN,
                }),
                rathole_relay(),
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<EnteredRelay>(json.clone()).unwrap(),
                relay,
                "{json}"
            );
        }
        for json in [
            serde_json::json!({"kind": "selfHostedWildflower", "base_url": "https://relay.example.com"}),
            serde_json::json!({
                "kind": "rathole",
                "remote_addr": "relay.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": RELAY_DOMAIN,
            }),
            serde_json::json!({
                "kind": "selfHostedWildflower",
                "baseUrl": "https://relay.example.com",
                "relayPin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY},
            }),
            serde_json::json!({
                "kind": "rathole",
                "remoteAddr": "relay.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": RELAY_DOMAIN,
                "baseUrl": "https://relay.example.com",
            }),
            serde_json::json!({
                "kind": "selfHostedWildflower",
                "baseUrl": "https://relay.example.com",
                "pin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY, "domain": RELAY_DOMAIN},
            }),
        ] {
            assert!(
                serde_json::from_value::<EnteredRelay>(json.clone()).is_err(),
                "{json}"
            );
        }
    }

    #[tokio::test]
    async fn set_credentials_replaces_the_token_and_keeps_the_rest() {
        let (_data_root, registry) = registry();
        let mut registered = official_record("ruth");
        registered.token = TunnelToken::new("the-old-token");
        registered.public_settings = served_settings();
        registered.staging_certificates = true;
        registered.launcher_url = Url::parse("http://localhost:5200/").unwrap();
        registry.insert(registered.clone()).unwrap();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                ..registered
            }
        );
        assert_eq!(
            relay_client.built_for(),
            vec![RelayKind::wildflower_base_url()]
        );
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn set_credentials_for_an_unknown_domain_builds_no_site() {
        let (_data_root, registry) = registry();
        assert!(matches!(
            set_server_credentials(
                registry,
                "ruth.relay.example.com",
                TunnelToken::new(TOKEN),
                no_client,
            )
            .await,
            Err(EnrolmentError::Registry(
                RegistryError::NotRegistered { .. }
            ))
        ));
    }

    #[tokio::test]
    async fn set_credentials_refuses_a_relay_that_moved_domain_or_rejects_the_token() {
        let (_data_root, registry) = registry();
        let mut moved = official_record("ruth");
        moved.public_settings = PublicRatholeSettings {
            domain: "old.example.com".to_owned(),
            ..served_settings()
        };
        let mut same = official_record("lab");
        same.public_settings = served_settings();
        registry.insert(moved.clone()).unwrap();
        registry.insert(same.clone()).unwrap();
        let relay_client = FakeRelayClient::serving(served_settings());

        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                "ruth.old.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await,
            Err(EnrolmentError::DomainChanged { registered, served })
                if registered == "old.example.com" && served == RELAY_DOMAIN
        ));
        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                "lab.relay.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await,
            Err(EnrolmentError::SignedRequestRejected { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), vec![moved, same]);
    }

    #[tokio::test]
    async fn set_credentials_for_a_rathole_server_replaces_only_the_token_without_a_request() {
        let (_data_root, registry) = registry();
        let registered = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            ruth(),
            TunnelToken::new("the-old-token"),
            no_client,
        )
        .await
        .unwrap();

        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new("the-new-token"),
            no_client,
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                token: TunnelToken::new("the-new-token"),
                ..registered
            }
        );
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn a_rathole_relay_s_entered_address_is_stored_case_folded() {
        let (_data_root, registry) = registry();
        let record = add_server(
            Arc::clone(&registry),
            EnteredRelay::Rathole {
                identity: RelayIdentity {
                    remote_addr: "Relay.Example.com:2333".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                },
                domain: RELAY_DOMAIN.to_owned(),
            },
            ruth(),
            TunnelToken::new(TOKEN),
            no_client,
        )
        .await
        .unwrap();
        assert_eq!(record.public_settings.remote_addr, "relay.example.com:2333");
    }

    #[tokio::test]
    async fn a_base_url_a_relay_site_cannot_be_asked_at_is_an_invalid_setting() {
        for base_url in [
            "relay.example.com",
            "http://relay.example.com",
            "https://user:pass@relay.example.com",
            "https://relay.example.com/?x=1",
            "https://relay.example.com/#top",
            "file:///relay",
        ] {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                EnteredRelay::SelfHostedWildflower {
                    base_url: base_url.to_owned(),
                    pin: None,
                },
                ruth(),
                TunnelToken::new(TOKEN),
                no_client,
            )
            .await;
            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::InvalidRelaySetting {
                        setting: "baseUrl",
                        ..
                    })
                ),
                "{base_url:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_base_url_with_a_path_prefix_is_kept() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let record = add_server(
            Arc::clone(&registry),
            EnteredRelay::SelfHostedWildflower {
                base_url: "https://example.com/relay".to_owned(),
                pin: None,
            },
            ruth(),
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();
        let base_url = Url::parse("https://example.com/relay").unwrap();
        assert_eq!(relay_client.built_for(), vec![base_url.clone()]);
        assert_eq!(record.relay, RelayKind::SelfHostedWildflower { base_url });
    }

    /// The relay's identity was pinned when the server was added: a token
    /// re-entered against a relay that now presents another address or noise
    /// key is refused before the signed request, and nothing is written.
    #[tokio::test]
    async fn set_credentials_refuses_a_relay_whose_identity_changed() {
        for (setting, served) in [
            (
                "remoteAddr",
                PublicRatholeSettings {
                    remote_addr: "elsewhere.example.com:2333".to_owned(),
                    ..served_settings()
                },
            ),
            (
                "publicKey",
                PublicRatholeSettings {
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                    ..served_settings()
                },
            ),
        ] {
            let (_data_root, registry) = registry();
            let registered = add(
                &registry,
                &FakeRelayClient::serving(served_settings()),
                self_hosted_relay(None),
                TOKEN,
            )
            .await
            .unwrap();
            let relay_client = FakeRelayClient::serving(served.clone());

            let result = set_server_credentials(
                Arc::clone(&registry),
                "ruth.relay.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await;

            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::RelayIdentityChanged { setting: changed, registered, served: now })
                        if *changed == setting && registered != now
                ),
                "{setting}: {result:?}"
            );
            assert_eq!(result.unwrap_err().kind(), "relayIdentityChanged");
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), vec![registered]);
        }
    }

    /// A relay that serves the address it was added with in another case is
    /// the same relay.
    #[tokio::test]
    async fn set_credentials_accepts_the_same_address_in_another_case() {
        let (_data_root, registry) = registry();
        add(
            &registry,
            &FakeRelayClient::serving(served_settings()),
            self_hosted_relay(None),
            TOKEN,
        )
        .await
        .unwrap();
        let relay_client = FakeRelayClient::serving(PublicRatholeSettings {
            remote_addr: "RELAY.example.com:2333".to_owned(),
            ..served_settings()
        });
        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();
        assert_eq!(record.public_settings, served_settings());
    }
}
