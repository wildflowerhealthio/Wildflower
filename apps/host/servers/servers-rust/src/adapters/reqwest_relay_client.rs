//! [`ReqwestRelayClient`]: the [`RelayClient`] over HTTPS, for one relay's
//! site.
//!
//! The relay's site has a publicly trusted certificate for its own hostname,
//! so requests are TLS-only and checked against the bundled web PKI roots.
//! It answers both paths itself, so a redirect is a bad response rather than
//! followed. The base URL is treated as a directory: a site served under a
//! path prefix, `https://example.com/relay`, is asked for
//! `https://example.com/relay/rathole`, not `https://example.com/rathole`.
//! `GET /me` is signed with the tunnel's token (see [`RequestSignature`]); the
//! token is never sent.

use std::time::Duration;

use reqwest::StatusCode;
use url::Url;
use wildflowerhealthio_rathole_settings::{PublicRatholeSettings, TunnelHost, TunnelName};

use super::request_signature::RequestSignature;
use crate::domain::{EnrolmentError, TunnelToken};
use crate::ports::RelayClient;

/// How long one request to the relay's site may take, connection included.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The [`RelayClient`] at one relay's base URL, over `reqwest` with `rustls`
/// (no openssl). Enrolment builds one for each relay it asks.
pub struct ReqwestRelayClient {
    relay_base: Url,
    client: reqwest::Client,
}

impl ReqwestRelayClient {
    /// The site at `relay_base`, with its own HTTP client.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::RelayUnreachable`] if the HTTP client can't be
    /// built, which only a broken TLS backend does.
    pub fn new(relay_base: Url) -> Result<Self, EnrolmentError> {
        match client_builder().build() {
            Ok(client) => Ok(Self::with_client(relay_base, client)),
            Err(error) => Err(EnrolmentError::RelayUnreachable {
                relay_base,
                source: error.into(),
            }),
        }
    }

    /// The site at `relay_base` over `client`, e.g. one that trusts a test
    /// relay's certificate.
    pub(crate) fn with_client(mut relay_base: Url, client: reqwest::Client) -> Self {
        if !relay_base.path().ends_with('/') {
            let directory = format!("{}/", relay_base.path());
            relay_base.set_path(&directory);
        }
        Self { relay_base, client }
    }

    /// `{relay base}{path}`, `path` being `/`-rooted at the base URL's own
    /// path rather than its host's.
    fn target_uri(&self, path: &str) -> Result<Url, url::ParseError> {
        self.relay_base.join(path.trim_start_matches('/'))
    }

    /// `GET {relay base}{path}`, signed as the tunnel in `sign_as` when there
    /// is one, or why no response came back.
    async fn get(
        &self,
        path: &'static str,
        sign_as: Option<(&TunnelName, &TunnelToken)>,
    ) -> Result<reqwest::Response, EnrolmentError> {
        let unreachable =
            |source: Box<dyn std::error::Error + Send + Sync>| EnrolmentError::RelayUnreachable {
                relay_base: self.relay_base.clone(),
                source,
            };
        let target_uri = self
            .target_uri(path)
            .map_err(|error| unreachable(error.into()))?;
        let mut request = self.client.get(target_uri.clone());
        if let Some((tunnel_name, token)) = sign_as {
            let signature = RequestSignature::sign(
                "GET",
                &target_uri,
                tunnel_name,
                token,
                chrono::Utc::now().timestamp(),
                &fresh_nonce(),
            );
            request = request
                .header("signature-input", signature.signature_input)
                .header("signature", signature.signature);
        }
        request
            .send()
            .await
            .map_err(|error| unreachable(error.into()))
    }
}

#[async_trait::async_trait]
impl RelayClient for ReqwestRelayClient {
    async fn public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError> {
        const PATH: &str = "/rathole";
        let response = self.get(PATH, None).await?;
        decode_success(PATH, response).await
    }

    async fn tunnel_host(
        &self,
        tunnel_name: &TunnelName,
        token: &TunnelToken,
    ) -> Result<TunnelHost, EnrolmentError> {
        const PATH: &str = "/me";
        let response = self.get(PATH, Some((tunnel_name, token))).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(EnrolmentError::SignedRequestRejected {
                tunnel_name: tunnel_name.clone(),
            });
        }
        decode_success(PATH, response).await
    }
}

/// The client settings every request to a relay's site is made with:
/// `rustls`, HTTPS only, [`REQUEST_TIMEOUT`] and no redirects.
fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
}

/// `response`'s JSON body as `T`, if its status is a success.
async fn decode_success<T: serde::de::DeserializeOwned>(
    path: &'static str,
    response: reqwest::Response,
) -> Result<T, EnrolmentError> {
    let bad = |reason: String| EnrolmentError::BadRelayResponse { path, reason };
    let status = response.status();
    if !status.is_success() {
        return Err(bad(format!("status {status}")));
    }
    response
        .json()
        .await
        .map_err(|error| bad(format!("{error:#}")))
}

/// 128 random bits, hex: a nonce the relay hasn't seen, safe in a
/// structured-field string.
fn fresh_nonce() -> String {
    rand::random::<[u8; 16]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex, OnceLock};

    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use rustls::sign::{CertifiedKey, SingleCertAndKey};
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use wildflowerhealthio_rathole_settings::{NoisePattern, Transport};
    use wildflowerhealthio_relay_server::{Secret, ServedTunnels, Site, Tunnel, Verifier};

    use super::*;
    use crate::domain::fixtures::launcher_url;
    use crate::domain::{add_server, EnteredRelay, RegistryError};
    use crate::{JsonServerRegistry, ServerRecord, ServerRegistry};

    /// A hostname the test resolves to the loopback relay itself.
    const RELAY_DOMAIN: &str = "relay.test";
    const TOKEN: &str = "s3cret-tunnel-token";

    fn served_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: format!("{RELAY_DOMAIN}:2333"),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    fn ruth() -> TunnelName {
        TunnelName::parse("ruth").unwrap()
    }

    /// The real relay's site, with a self-signed certificate for
    /// [`RELAY_DOMAIN`] in place of the ACME one, on a loopback port, holding
    /// the tunnel `ruth` with [`TOKEN`].
    struct TestRelay {
        addr: SocketAddr,
        cert: CertificateDer<'static>,
        _shutdown_tx: broadcast::Sender<bool>,
    }

    impl TestRelay {
        async fn start() -> Self {
            let rcgen::CertifiedKey { cert, key_pair } =
                rcgen::generate_simple_self_signed(vec![RELAY_DOMAIN.to_owned()]).unwrap();
            let cert = cert.der().clone();
            let key = CertifiedKey::from_der(
                vec![cert.clone()],
                PrivateKeyDer::Pkcs8(key_pair.serialize_der().into()),
                &rustls::crypto::ring::default_provider(),
            )
            .unwrap();
            let site = Arc::new(Site::new(
                Arc::new(SingleCertAndKey::from(key)),
                served_settings(),
                Arc::new(Verifier::new(
                    Arc::new(ServedTunnels::new(&[Tunnel {
                        name: ruth().into(),
                        token: Secret::new(TOKEN),
                    }])),
                    None,
                )),
                None,
            ));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let site = Arc::clone(&site);
                    let shutdown_rx = shutdown_rx.resubscribe();
                    tokio::spawn(async move {
                        site.serve(stream, Duration::from_secs(5), shutdown_rx)
                            .await;
                    });
                }
            });
            Self {
                addr,
                cert,
                _shutdown_tx: shutdown_tx,
            }
        }

        /// The relay as the user would enter it.
        fn relay(&self) -> EnteredRelay {
            EnteredRelay::SelfHostedWildflower {
                base_url: self.base_url().to_string(),
                pin: None,
            }
        }

        fn base_url(&self) -> Url {
            Url::parse(&format!("https://{RELAY_DOMAIN}:{}", self.addr.port())).unwrap()
        }

        /// A [`ReqwestRelayClient`] for this relay's site.
        fn relay_client(&self) -> ReqwestRelayClient {
            self.client_at(self.base_url())
        }

        /// A [`ReqwestRelayClient`] at `relay_base` that trusts only this
        /// relay's certificate and resolves [`RELAY_DOMAIN`] to it.
        fn client_at(&self, relay_base: Url) -> ReqwestRelayClient {
            ReqwestRelayClient::with_client(
                relay_base,
                client_builder()
                    .tls_built_in_root_certs(false)
                    .add_root_certificate(reqwest::Certificate::from_der(&self.cert).unwrap())
                    .resolve(RELAY_DOMAIN, self.addr)
                    .build()
                    .unwrap(),
            )
        }
    }

    /// The base URL is a directory: its path prefix, with or without a
    /// trailing slash, is kept in front of each path.
    #[test]
    fn paths_are_joined_under_the_base_url_s_own_path() {
        let client = reqwest::Client::new();
        for (relay_base, rathole, me) in [
            (
                "https://relay.example.com",
                "https://relay.example.com/rathole",
                "https://relay.example.com/me",
            ),
            (
                "https://example.com/relay",
                "https://example.com/relay/rathole",
                "https://example.com/relay/me",
            ),
            (
                "https://example.com/a/relay/",
                "https://example.com/a/relay/rathole",
                "https://example.com/a/relay/me",
            ),
        ] {
            let relay_client =
                ReqwestRelayClient::with_client(Url::parse(relay_base).unwrap(), client.clone());
            assert_eq!(
                relay_client.target_uri("/rathole").unwrap().as_str(),
                rathole
            );
            assert_eq!(relay_client.target_uri("/me").unwrap().as_str(), me);
        }
    }

    #[tokio::test]
    async fn fetches_the_relay_s_public_settings() {
        let relay = TestRelay::start().await;
        assert_eq!(
            relay.relay_client().public_settings().await.unwrap(),
            served_settings()
        );
    }

    /// The relay's own verifier accepts the signature: the relay answers
    /// `GET /me` with the tunnel.
    #[tokio::test]
    async fn a_signed_me_is_accepted_by_the_real_verifier() {
        let relay = TestRelay::start().await;
        let tunnel_host = relay
            .relay_client()
            .tunnel_host(&ruth(), &TunnelToken::new(TOKEN))
            .await
            .unwrap();
        assert_eq!(
            tunnel_host,
            TunnelHost {
                tunnel_name: TunnelName::parse("ruth").unwrap(),
                public_host: format!("ruth.{RELAY_DOMAIN}"),
            }
        );
    }

    /// Each request gets a fresh nonce, so a second enrolment isn't refused
    /// as a replay.
    #[tokio::test]
    async fn repeated_signed_requests_are_each_accepted() {
        let relay = TestRelay::start().await;
        let relay_client = relay.relay_client();
        for _ in 0..3 {
            relay_client
                .tunnel_host(&ruth(), &TunnelToken::new(TOKEN))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn a_wrong_token_or_unknown_name_is_rejected() {
        let relay = TestRelay::start().await;
        let relay_client = relay.relay_client();
        for (tunnel_name, token) in [("ruth", "not-the-token"), ("someone-else", TOKEN)] {
            let tunnel_name = TunnelName::parse(tunnel_name).unwrap();
            let result = relay_client
                .tunnel_host(&tunnel_name, &TunnelToken::new(token))
                .await;
            assert!(
                matches!(&result, Err(EnrolmentError::SignedRequestRejected { tunnel_name: rejected }) if *rejected == tunnel_name),
                "{tunnel_name}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_relay_that_is_not_listening_is_unreachable() {
        let relay = TestRelay::start().await;
        // A port nothing listens on.
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        let relay_base = Url::parse(&format!("https://127.0.0.1:{closed_port}")).unwrap();
        assert!(matches!(
            relay.client_at(relay_base).public_settings().await,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        // Plain HTTP is never sent.
        let plain_http =
            Url::parse(&format!("http://{RELAY_DOMAIN}:{}", relay.addr.port())).unwrap();
        assert!(matches!(
            relay.client_at(plain_http).public_settings().await,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
    }

    #[tokio::test]
    async fn a_path_the_relay_does_not_serve_is_a_bad_response() {
        let relay = TestRelay::start().await;
        let response = relay.relay_client().get("/nothing", None).await.unwrap();
        assert!(matches!(
            decode_success::<PublicRatholeSettings>("/nothing", response).await,
            Err(EnrolmentError::BadRelayResponse { path: "/nothing", reason }) if reason.contains("404")
        ));
        // `GET /health` answers, but not with rathole settings.
        let response = relay.relay_client().get("/health", None).await.unwrap();
        assert!(matches!(
            decode_success::<PublicRatholeSettings>("/health", response).await,
            Err(EnrolmentError::BadRelayResponse {
                path: "/health",
                ..
            })
        ));
    }

    /// Enrolment against the real relay, end to end, into a real registry.
    #[tokio::test]
    async fn adds_a_server_through_the_real_relay() {
        let relay = TestRelay::start().await;
        let data_root = tempfile::tempdir().unwrap();
        let registry: Arc<dyn ServerRegistry> =
            Arc::new(JsonServerRegistry::in_data_root(data_root.path()));

        let record = add_server(
            Arc::clone(&registry),
            relay.relay(),
            ruth(),
            TunnelToken::new(TOKEN),
            launcher_url(),
            |relay_base| Ok(relay.client_at(relay_base)),
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        assert_eq!(record.domain(), format!("ruth.{RELAY_DOMAIN}"));
        assert_eq!(record.public_settings, served_settings());
        assert_eq!(record.launcher_url, launcher_url());
        assert_eq!(
            record.certificate_authority,
            ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY
        );
        assert_eq!(registry.read_all().unwrap(), vec![record]);
        assert!(matches!(
            add_server(
                Arc::clone(&registry),
                relay.relay(),
                ruth(),
                TunnelToken::new(TOKEN),
                launcher_url(),
                |relay_base| Ok(relay.client_at(relay_base)),
                chrono::Utc::now(),
            )
            .await,
            Err(EnrolmentError::Registry(
                RegistryError::AlreadyRegistered { .. }
            ))
        ));
    }

    /// Everything a failed enrolment produces is free of the token: its
    /// error's `Display` and `Debug`, and every log line from both ends.
    #[tokio::test]
    async fn the_token_appears_in_no_error_or_log() {
        let logs = captured_logs();
        let relay = TestRelay::start().await;
        let data_root = tempfile::tempdir().unwrap();
        let registry: Arc<dyn ServerRegistry> =
            Arc::new(JsonServerRegistry::in_data_root(data_root.path()));
        let wrong_token = "the-wrong-s3cret";

        let mut errors = Vec::new();
        for (relay_base, token) in [
            (relay.base_url(), wrong_token),
            (Url::parse("https://127.0.0.1:1").unwrap(), TOKEN),
        ] {
            errors.push(
                add_server(
                    Arc::clone(&registry),
                    EnteredRelay::SelfHostedWildflower {
                        base_url: relay_base.to_string(),
                        pin: None,
                    },
                    ruth(),
                    TunnelToken::new(token),
                    launcher_url(),
                    |relay_base| Ok(relay.client_at(relay_base)),
                    chrono::Utc::now(),
                )
                .await
                .unwrap_err(),
            );
        }

        assert!(matches!(
            errors[0],
            EnrolmentError::SignedRequestRejected { .. }
        ));
        assert!(matches!(errors[1], EnrolmentError::RelayUnreachable { .. }));
        let logged = logs.text();
        assert!(logged.contains("signed request rejected"), "{logged}");
        for rendered in errors
            .iter()
            .flat_map(|error| [error.to_string(), format!("{error:?}")])
            .chain([logged])
        {
            for token in [TOKEN, wrong_token] {
                assert!(!rendered.contains(token), "token leaked: {rendered}");
            }
        }
    }

    /// Every log line of this test process from the first call on, at every
    /// level. Process-wide rather than scoped to one test: a scoped subscriber
    /// misses events whose callsites another test thread has already cached
    /// as uninteresting.
    fn captured_logs() -> CapturedLogs {
        static LOGS: OnceLock<CapturedLogs> = OnceLock::new();
        LOGS.get_or_init(|| {
            let logs = CapturedLogs::default();
            tracing::subscriber::set_global_default(
                tracing_subscriber::fmt()
                    .with_max_level(tracing::Level::TRACE)
                    .with_writer({
                        let logs = logs.clone();
                        move || logs.clone()
                    })
                    .finish(),
            )
            .expect("no other test sets a global subscriber");
            logs
        })
        .clone()
    }

    /// Log output, collected for a test to read back.
    #[derive(Clone, Default)]
    struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

    impl CapturedLogs {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    impl std::io::Write for CapturedLogs {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
