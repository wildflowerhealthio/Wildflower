//! Enrolment: adding a server from a relay, a tunnel name and its token, and
//! re-entering a server's token.
//!
//! Both go through the relay's own site ([`RelaySite`]) the same way. Its
//! `GET /rathole` is fetched and checked, then compared with the user's
//! [`RelayPin`] when there is one. Then a `GET /me` signed with the token
//! confirms the relay holds that tunnel name and token, and that it reaches
//! the tunnel at `<tunnel name>.<relay domain>`. Only then is the registry
//! written. The response to `GET /rathole` becomes the record's
//! `public_settings`; a pin is checked and never stored.

use std::sync::Arc;

use rathole_settings_rust::{is_dns_label, PublicRatholeSettings, TunnelHost, TunnelName};
use serde::Deserialize;
use url::Url;

use crate::domain::{EnrolmentError, RegistryError, Relay, ServerRecord, TunnelToken};
use crate::ports::{RelaySite, ServerRegistry};

/// The relay settings a user entered by hand to check `GET /rathole`
/// against: enrolment fails unless the relay serves exactly these.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayPin {
    /// The `host:port` the rathole client must be told to dial. Compared
    /// ignoring ASCII case, as the relay serves it lowercased.
    pub remote_addr: String,
    /// The relay's X25519 noise public key, base64.
    pub public_key: String,
}

impl RelayPin {
    /// Whether `public_settings` serves the pinned address and key.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::PinMismatch`] naming the first setting that differs.
    fn check(&self, public_settings: &PublicRatholeSettings) -> Result<(), EnrolmentError> {
        if !self
            .remote_addr
            .eq_ignore_ascii_case(&public_settings.remote_addr)
        {
            return Err(EnrolmentError::PinMismatch {
                setting: "remote_addr",
                pinned: self.remote_addr.clone(),
                served: public_settings.remote_addr.clone(),
            });
        }
        if self.public_key != public_settings.public_key {
            return Err(EnrolmentError::PinMismatch {
                setting: "public_key",
                pinned: self.public_key.clone(),
                served: public_settings.public_key.clone(),
            });
        }
        Ok(())
    }
}

/// Enrol `tunnel_name` at `relay` with `token` and register the server, with
/// the default launcher and production certificates.
///
/// # Errors
///
/// Any [`EnrolmentError`] from the relay's site, with nothing written, or
/// [`EnrolmentError::Registry`]; a server with the same domain is
/// [`RegistryError::AlreadyRegistered`].
pub async fn add_server(
    registry: Arc<dyn ServerRegistry>,
    relay_site: &dyn RelaySite,
    relay: Relay,
    relay_pin: Option<&RelayPin>,
    tunnel_name: TunnelName,
    token: TunnelToken,
) -> Result<ServerRecord, EnrolmentError> {
    let public_settings = confirmed_public_settings(
        relay_site,
        &relay.base_url(),
        relay_pin,
        &tunnel_name,
        &token,
    )
    .await?;
    let record = ServerRecord {
        relay,
        tunnel_name,
        token,
        public_settings,
        launcher_url: ServerRecord::default_launcher_url(),
        staging_certificates: false,
    };
    let inserted = record.clone();
    run_blocking(registry, move |registry| registry.insert(inserted)).await?;
    Ok(record)
}

/// Replace the token of the server with `domain` by `token`, after checking
/// it with its relay the way [`add_server`] does. The record takes the
/// relay's current `GET /rathole` as its `public_settings`; everything else
/// is kept.
///
/// # Errors
///
/// [`RegistryError::NotRegistered`] when no server has `domain`, checked
/// before the relay is asked; [`EnrolmentError::DomainChanged`] when the relay
/// now serves another domain; any other [`EnrolmentError`] from the relay's
/// site, with nothing written; or a registry failure.
pub async fn set_server_credentials(
    registry: Arc<dyn ServerRegistry>,
    relay_site: &dyn RelaySite,
    domain: &str,
    token: TunnelToken,
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
    let public_settings = confirmed_public_settings(
        relay_site,
        &registered.relay.base_url(),
        None,
        &registered.tunnel_name,
        &token,
    )
    .await?;
    if public_settings.domain != registered.public_settings.domain {
        return Err(EnrolmentError::DomainChanged {
            registered: registered.public_settings.domain,
            served: public_settings.domain,
        });
    }
    let record = ServerRecord {
        token,
        public_settings,
        ..registered
    };
    let updated = record.clone();
    run_blocking(registry, move |registry| registry.update(updated)).await?;
    Ok(record)
}

/// The relay's `GET /rathole`, checked and compared with `relay_pin`, once a
/// signed `GET /me` confirms it holds `tunnel_name` and `token`.
async fn confirmed_public_settings(
    relay_site: &dyn RelaySite,
    relay_base: &Url,
    relay_pin: Option<&RelayPin>,
    tunnel_name: &TunnelName,
    token: &TunnelToken,
) -> Result<PublicRatholeSettings, EnrolmentError> {
    let public_settings = relay_site.fetch_public_settings(relay_base).await?;
    check_public_settings(&public_settings)?;
    if let Some(relay_pin) = relay_pin {
        relay_pin.check(&public_settings)?;
    }
    let tunnel_host = relay_site
        .fetch_tunnel_host(relay_base, tunnel_name, token)
        .await?;
    check_tunnel_host(&tunnel_host, tunnel_name, &public_settings.domain)?;
    Ok(public_settings)
}

/// Whether a `GET /rathole` response is one a server can be built on: its
/// `domain` is a lowercase DNS name, since it ends the server's domain and
/// folder name, and its `remote_addr` a `host:port`.
fn check_public_settings(public_settings: &PublicRatholeSettings) -> Result<(), EnrolmentError> {
    let bad = |reason: String| EnrolmentError::BadRelayResponse {
        path: "/rathole",
        reason,
    };
    let domain = &public_settings.domain;
    if !domain.split('.').all(is_dns_label) {
        return Err(bad(format!(
            "domain {domain:?} is not a lowercase DNS name"
        )));
    }
    let remote_addr = &public_settings.remote_addr;
    let addr_is_valid = remote_addr.rsplit_once(':').is_some_and(|(host, port)| {
        !host.is_empty() && port.parse::<u16>().is_ok_and(|port| port != 0)
    });
    if !addr_is_valid {
        return Err(bad(format!("remote_addr {remote_addr:?} is not host:port")));
    }
    Ok(())
}

/// Whether `GET /me` named the tunnel that signed, at `<tunnel name>.<domain>`
/// for the `domain` `GET /rathole` served.
fn check_tunnel_host(
    tunnel_host: &TunnelHost,
    tunnel_name: &TunnelName,
    domain: &str,
) -> Result<(), EnrolmentError> {
    let expected_public_host = format!("{tunnel_name}.{domain}");
    if tunnel_host.tunnel_name != tunnel_name.as_str()
        || tunnel_host.public_host != expected_public_host
    {
        return Err(EnrolmentError::BadRelayResponse {
            path: "/me",
            reason: format!(
                "it names {:?} at {:?}, not {:?} at {expected_public_host:?}",
                tunnel_host.tunnel_name,
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

    use rathole_settings_rust::{NoisePattern, Transport};

    use super::*;
    use crate::domain::fixtures::{wildflower_record, TOKEN};
    use crate::JsonServerRegistry;

    const RELAY_DOMAIN: &str = "relay.example.com";

    fn served_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: format!("{RELAY_DOMAIN}:2333"),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    /// A relay site that serves `public_settings` (or is unreachable when
    /// there are none) and accepts `tunnel_name` with [`TOKEN`].
    struct FakeRelaySite {
        public_settings: Option<PublicRatholeSettings>,
        tunnel_name: &'static str,
        /// What `GET /me` answers, in place of the signing tunnel's host.
        tunnel_host: Option<TunnelHost>,
        /// How many `GET /me` requests were made.
        tunnel_host_fetches: AtomicUsize,
    }

    impl FakeRelaySite {
        fn serving(public_settings: PublicRatholeSettings) -> Self {
            Self {
                public_settings: Some(public_settings),
                tunnel_name: "ruth",
                tunnel_host: None,
                tunnel_host_fetches: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl RelaySite for FakeRelaySite {
        async fn fetch_public_settings(
            &self,
            relay_base: &Url,
        ) -> Result<PublicRatholeSettings, EnrolmentError> {
            self.public_settings
                .clone()
                .ok_or_else(|| EnrolmentError::RelayUnreachable {
                    relay_base: relay_base.clone(),
                    source: "connection refused".into(),
                })
        }

        async fn fetch_tunnel_host(
            &self,
            _relay_base: &Url,
            tunnel_name: &TunnelName,
            token: &TunnelToken,
        ) -> Result<TunnelHost, EnrolmentError> {
            self.tunnel_host_fetches.fetch_add(1, Ordering::SeqCst);
            if tunnel_name.as_str() != self.tunnel_name || token.expose() != TOKEN {
                return Err(EnrolmentError::CredentialsRejected {
                    tunnel_name: tunnel_name.clone(),
                });
            }
            let domain = &self.public_settings.as_ref().unwrap().domain;
            Ok(self.tunnel_host.clone().unwrap_or_else(|| TunnelHost {
                tunnel_name: tunnel_name.as_str().to_owned(),
                public_host: format!("{tunnel_name}.{domain}"),
            }))
        }
    }

    fn registry() -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = Arc::new(JsonServerRegistry::in_data_root(data_root.path()));
        (data_root, registry)
    }

    fn custom_relay() -> Relay {
        Relay::Custom {
            base_url: Url::parse(&format!("https://{RELAY_DOMAIN}")).unwrap(),
        }
    }

    fn ruth() -> TunnelName {
        TunnelName::parse("ruth").unwrap()
    }

    async fn add(
        registry: &Arc<dyn ServerRegistry>,
        relay_site: &FakeRelaySite,
        relay_pin: Option<&RelayPin>,
        token: &str,
    ) -> Result<ServerRecord, EnrolmentError> {
        add_server(
            Arc::clone(registry),
            relay_site,
            custom_relay(),
            relay_pin,
            ruth(),
            TunnelToken::new(token),
        )
        .await
    }

    #[tokio::test]
    async fn adds_a_server_from_the_relay_s_settings() {
        let (_data_root, registry) = registry();
        let relay_site = FakeRelaySite::serving(served_settings());

        let record = add(&registry, &relay_site, None, TOKEN).await.unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: custom_relay(),
                tunnel_name: ruth(),
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                launcher_url: ServerRecord::default_launcher_url(),
                staging_certificates: false,
            }
        );
        assert_eq!(record.domain(), "ruth.relay.example.com");
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn a_matching_pin_is_accepted_and_not_stored() {
        let (_data_root, registry) = registry();
        let relay_site = FakeRelaySite::serving(served_settings());
        let relay_pin = RelayPin {
            remote_addr: "Relay.Example.com:2333".to_owned(),
            public_key: served_settings().public_key,
        };

        let record = add(&registry, &relay_site, Some(&relay_pin), TOKEN)
            .await
            .unwrap();

        assert_eq!(record.public_settings, served_settings());
        assert_eq!(record.relay, custom_relay());
    }

    #[tokio::test]
    async fn a_pin_the_relay_does_not_serve_fails_before_the_signed_request() {
        for (relay_pin, mismatched) in [
            (
                RelayPin {
                    remote_addr: "relay.example.com:7000".to_owned(),
                    public_key: served_settings().public_key,
                },
                "remote_addr",
            ),
            (
                RelayPin {
                    remote_addr: served_settings().remote_addr,
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                },
                "public_key",
            ),
        ] {
            let (_data_root, registry) = registry();
            let relay_site = FakeRelaySite::serving(served_settings());
            let result = add(&registry, &relay_site, Some(&relay_pin), TOKEN).await;
            assert!(
                matches!(result, Err(EnrolmentError::PinMismatch { setting, .. }) if setting == mismatched),
                "{mismatched}"
            );
            assert_eq!(relay_site.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn an_unreachable_relay_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_site = FakeRelaySite {
            public_settings: None,
            ..FakeRelaySite::serving(served_settings())
        };
        assert!(matches!(
            add(&registry, &relay_site, None, TOKEN).await,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_rejected_token_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_site = FakeRelaySite::serving(served_settings());
        assert!(matches!(
            add(&registry, &relay_site, None, "not-the-token").await,
            Err(EnrolmentError::CredentialsRejected { tunnel_name }) if tunnel_name == ruth()
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn rathole_settings_a_server_cannot_be_built_on_are_a_bad_response() {
        for (field, value) in [
            ("domain", "Relay.example.com"),
            ("domain", "../relay"),
            ("domain", ""),
            ("remote_addr", "relay.example.com"),
            ("remote_addr", "relay.example.com:0"),
            ("remote_addr", ":2333"),
        ] {
            let mut public_settings = served_settings();
            match field {
                "domain" => public_settings.domain = value.to_owned(),
                _ => public_settings.remote_addr = value.to_owned(),
            }
            let (_data_root, registry) = registry();
            let relay_site = FakeRelaySite::serving(public_settings);
            assert!(
                matches!(
                    add(&registry, &relay_site, None, TOKEN).await,
                    Err(EnrolmentError::BadRelayResponse {
                        path: "/rathole",
                        ..
                    })
                ),
                "{field} {value:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_me_response_naming_another_tunnel_or_host_is_a_bad_response() {
        for tunnel_host in [
            TunnelHost {
                tunnel_name: "someone-else".to_owned(),
                public_host: "ruth.relay.example.com".to_owned(),
            },
            TunnelHost {
                tunnel_name: "ruth".to_owned(),
                public_host: "ruth.elsewhere.example.com".to_owned(),
            },
        ] {
            let (_data_root, registry) = registry();
            let relay_site = FakeRelaySite {
                tunnel_host: Some(tunnel_host.clone()),
                ..FakeRelaySite::serving(served_settings())
            };
            assert!(
                matches!(
                    add(&registry, &relay_site, None, TOKEN).await,
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
        let relay_site = FakeRelaySite::serving(served_settings());
        let existing = add(&registry, &relay_site, None, TOKEN).await.unwrap();

        assert!(matches!(
            add(&registry, &relay_site, None, TOKEN).await,
            Err(EnrolmentError::Registry(RegistryError::AlreadyRegistered { domain }))
                if domain == "ruth.relay.example.com"
        ));
        assert_eq!(registry.read_all().unwrap(), vec![existing]);
    }

    #[tokio::test]
    async fn set_credentials_replaces_the_token_and_settings_and_keeps_the_rest() {
        let (_data_root, registry) = registry();
        let mut registered = wildflower_record("ruth");
        registered.token = TunnelToken::new("the-old-token");
        registered.public_settings.domain = RELAY_DOMAIN.to_owned();
        registered.staging_certificates = true;
        registered.launcher_url = Url::parse("http://localhost:5200/").unwrap();
        registry.insert(registered.clone()).unwrap();
        let relay_site = FakeRelaySite::serving(served_settings());

        let record = set_server_credentials(
            Arc::clone(&registry),
            &relay_site,
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
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
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn set_credentials_for_an_unknown_domain_asks_no_relay() {
        let (_data_root, registry) = registry();
        let relay_site = FakeRelaySite {
            public_settings: None,
            ..FakeRelaySite::serving(served_settings())
        };
        assert!(matches!(
            set_server_credentials(
                registry,
                &relay_site,
                "ruth.relay.example.com",
                TunnelToken::new(TOKEN)
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
        let mut registered = wildflower_record("ruth");
        registered.public_settings.domain = "old.example.com".to_owned();
        registry.insert(registered.clone()).unwrap();
        let relay_site = FakeRelaySite::serving(served_settings());

        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                &relay_site,
                "ruth.old.example.com",
                TunnelToken::new(TOKEN)
            )
            .await,
            Err(EnrolmentError::DomainChanged { registered, served })
                if registered == "old.example.com" && served == RELAY_DOMAIN
        ));
        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                &relay_site,
                "ruth.old.example.com",
                TunnelToken::new("wrong")
            )
            .await,
            Err(EnrolmentError::CredentialsRejected { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), vec![registered]);
    }
}
