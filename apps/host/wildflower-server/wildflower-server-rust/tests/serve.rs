//! The server's lifecycle: `set_up` creates the server's folder and opens its
//! databases there, and once it has bound the port, cancelling `serve`'s
//! shutdown token makes it return `Ok`. The loopback port is then free for a
//! second server over the same folder and the same host channels, which comes
//! up and answers `/health`. While serving, the host's observers see the
//! server's health through its public origin, its tunnel's state and each
//! forwarded request, and the request log records
//! each forwarded request and serves it back on `/requests` to a token holding
//! the request log's read scope — a token naming the server's origin as `iss`
//! and `aud`, accepted from a direct loopback caller, from a front run on this
//! machine and through the tunnel listener, while one another server minted is
//! refused.
//!
//! The tunnel listener serves the same API as a remote origin, over TLS with
//! the certificate cached for the server's domain: its connections are held to
//! the server's domain by their SNI and their requests by their `Host`,
//! are served as the public origin whatever
//! `Forwarded` they carry, and name the visitor from a PROXY protocol v2
//! header.
//!
//! A SMART app's launch carries a `launch` the apps slice mints through
//! the authorization server, which the app's `/oauth/authorize` consumes once.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, ServerName};
use rustls_acme::caches::DirCache;
use rustls_acme::CertCache;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflowerhealthio_authorization_server::domain::token::{mint_access_token, NewJwtArgs};
use wildflowerhealthio_authorization_server::{GrantStore, SqliteGrantStore};
use wildflowerhealthio_kitchen_sink::loopback_port::free_loopback_port;
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::health_check::{
    ComponentType, HealthReport, HealthStatus,
};
use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_shared_structures::request_caller::ForwardedRequest;
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;
use wildflowerhealthio_tunnel::{TunnelState, TunnelStream};
use wildflowerhealthio_wildflower_server::{
    set_up, CertificateAuthority, DeviceCertificateConfig, ServerObservers, WildflowerServerConfig,
};

/// The `Forwarded` header a front run on this machine stamps on a request it
/// relayed to the loopback listener, from client `192.0.2.1` to
/// `demo.example.com`.
const FORWARDED: &str = "for=192.0.2.1;host=demo.example.com;proto=https";

/// The server's domain: the host every tunnel request must name. No relay
/// serves it, so the reachability monitor never reaches the server.
const DOMAIN: &str = "test.relay.invalid";

/// The server's origin, from [`DOMAIN`]: the `iss` and `aud` of every
/// token the server accepts, whichever origin a request was served on.
const SERVER_ORIGIN: &str = "https://test.relay.invalid";

/// Another server's origin.
const OTHER_SERVER_ORIGIN: &str = "https://other.relay.invalid";

/// The CA the servers order from, which nothing answers at: a server with no
/// valid cached certificate orders one from it, and the order fails and is
/// retried in the background, which the server's lifecycle doesn't wait on.
const TEST_CA: CertificateAuthority = CertificateAuthority::UnreachableForTests;

/// How long one server may take to come up or wind down before the test fails
/// rather than hangs. Startup indexes the FHIR SearchParameter bundle, which is
/// the slow part.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(120);

fn server_config(server_dir: PathBuf, loopback_base_url: Url) -> WildflowerServerConfig {
    WildflowerServerConfig {
        search_parameter_data_dir: PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fhir-r4-rust/assets"
        )),
        launcher_base: LauncherBase::parse("https://launcher.test/launcher/")
            .expect("launcher base"),
        authorization_app_base: AuthorizationAppBase::parse(
            "https://authorization.test/authorization/",
        )
        .expect("authorization app base"),
        host_app_client_scopes:
            wildflowerhealthio_authorization_server::default_host_app_client_scopes(),
        wildflower_host_app_client_id:
            wildflowerhealthio_authorization_server::WILDFLOWER_HOST_APP_CLIENT_ID.to_owned(),
        // A relay nothing listens at: the tunnel dials and retries in the
        // background, which the server's lifecycle doesn't wait on, and the
        // domain below never answers.
        relay_settings: wildflowerhealthio_tunnel::RelaySettings {
            remote_addr: "127.0.0.1:9".to_owned(),
            token: "test-tunnel-token".to_owned(),
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            service_name: "test".to_owned(),
        },
        domain: DOMAIN.to_owned(),
        device_certificate: DeviceCertificateConfig {
            certificate_authority: TEST_CA,
            // The test's one temporary folder stands in for the data root too.
            certificate_dir: certificate_dir(&server_dir),
            acme_account_dir: server_dir.join("acme-account"),
        },
        runtime: ServerRuntimeConfig {
            loopback_base_url,
            server_dir,
        },
    }
}

/// The server's certificate folder, in its folder `server_dir`.
fn certificate_dir(server_dir: &Path) -> PathBuf {
    server_dir.join("certificates")
}

/// Set the server up, which binds the loopback port, then spawn `serve`.
async fn start_serving(
    config: WildflowerServerConfig,
    observers: ServerObservers,
    shutdown: CancellationToken,
) -> JoinHandle<anyhow::Result<()>> {
    let server = set_up(config, observers)
        .await
        .expect("the server sets up and binds");
    tokio::spawn(server.serve(shutdown))
}

/// The loopback `/health`'s status and its decoded health report.
async fn health_report(loopback_base_url: &Url) -> (reqwest::StatusCode, HealthReport) {
    let response = reqwest::get(loopback_base_url.join("health").expect("health URL"))
        .await
        .expect("GET /health reaches the server");
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    assert_eq!(content_type.as_deref(), Some("application/health+json"));
    (status, response.json().await.expect("a health report"))
}

async fn health_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    let health_url = loopback_base_url.join("health").expect("health URL");
    reqwest::get(health_url)
        .await
        .expect("GET /health reaches the server")
        .status()
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_returns_on_shutdown_and_the_port_rebinds() {
    let data_root = tempfile::tempdir().expect("temp data root");
    // A server's folder as the host lays it out, `<data root>/servers/<domain>/`,
    // which doesn't exist until the server creates it.
    let server_dir = data_root
        .path()
        .join("servers")
        .join("ruth.relay.wildflowerhealth.io");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");

    let (server_health_tx, server_health_rx) = watch::channel(None);
    let (tunnel_state_tx, mut tunnel_state_rx) = watch::channel(None);
    let (forwarded_request_tx, mut forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        tunnel_state_tx,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
        forwarded_request_tx,
    };
    let config = server_config(server_dir.clone(), loopback_base_url.clone());

    let first_shutdown = CancellationToken::new();
    let first = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(config.clone(), observers.clone(), first_shutdown.clone()),
    )
    .await
    .expect("the first serve binds in time");
    // Both databases are in the server's folder, and none in the data root.
    for database in ["wildflower.sqlite", "health-data.sqlite"] {
        assert!(
            server_dir.join(database).is_file(),
            "{database} is in the server's folder"
        );
        assert!(
            !data_root.path().join(database).exists(),
            "{database} is not in the data root"
        );
    }
    // No relay listens at the tunnel's relay address: the host sees the
    // tunnel reconnecting, with why.
    let published = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        tunnel_state_rx.wait_for(|tunnel_state| {
            matches!(tunnel_state, Some(TunnelState::Reconnecting { .. }))
        }),
    )
    .await
    .expect("the tunnel state is published in time")
    .expect("the test holds the tunnel-state sender")
    .clone();
    assert!(
        matches!(&published, Some(TunnelState::Reconnecting { error }) if !error.is_empty()),
        "{published:?}"
    );
    // `/health` is the two checks: the server passing, and its tunnel, which
    // is reconnecting, warning; a warning is still `200`.
    let (status, report) = health_report(&loopback_base_url).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(report.status, HealthStatus::Warn);
    let checks: Vec<(&str, Vec<(ComponentType, HealthStatus)>)> = report
        .checks
        .iter()
        .map(|(name, checks)| {
            (
                name.as_str(),
                checks
                    .iter()
                    .map(|check| (check.component_type, check.status))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        checks,
        vec![
            (
                "connectivity",
                vec![(ComponentType::Component, HealthStatus::Warn)]
            ),
            ("server", vec![(ComponentType::System, HealthStatus::Pass)]),
        ]
    );
    // The loopback `/health` above is not reported. A forwarded one is logged
    // but not sent to the host; a forwarded FHIR read is sent to both, with no
    // caller (`/metadata` is unauthenticated).
    let forwarded_health = reqwest::Client::new()
        .get(loopback_base_url.join("health").expect("health URL"))
        .header("forwarded", FORWARDED)
        .send()
        .await
        .expect("a forwarded GET /health reaches the server");
    assert_eq!(forwarded_health.status(), reqwest::StatusCode::OK);
    assert_eq!(
        forwarded_metadata_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );
    let forwarded_request = tokio::time::timeout(LIFECYCLE_TIMEOUT, forwarded_request_rx.recv())
        .await
        .expect("the forwarded request is reported in time")
        .expect("the test holds the report sender");
    assert_eq!(
        (
            forwarded_request.reduced_path.as_str(),
            forwarded_request.status,
            forwarded_request.client_address.as_deref(),
            forwarded_request.caller,
        ),
        ("/metadata", 200, Some("192.0.2.1"), None)
    );
    assert!(
        forwarded_request_rx.try_recv().is_err(),
        "only the forwarded request is reported"
    );
    // The host sees the server's health through its public origin only once
    // the tunnel is connected, which it never is here: well past the first
    // probe's delay, no verdict is published.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(*server_health_rx.borrow(), None);

    first_shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, first)
        .await
        .expect("the first serve returns in time once cancelled")
        .expect("the first serve task doesn't panic")
        .expect("a cancelled serve returns Ok");

    let second_shutdown = CancellationToken::new();
    let second = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(config, observers, second_shutdown.clone()),
    )
    .await
    .expect("the second serve binds the same port in time");
    assert_eq!(
        health_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );

    second_shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, second)
        .await
        .expect("the second serve returns in time once cancelled")
        .expect("the second serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}

/// A client token issued by and for `server_origin`, granting `scopes`, signed
/// with the key the authorization server keeps in the server's database under `app_data_dir`.
fn client_token(app_data_dir: &Path, server_origin: &str, scopes: &[String]) -> String {
    // The server's shared database (`WILDFLOWER_DB` in `set_up`); a wrong name
    // opens an empty one, with no signing key to find.
    let pool = wildflowerhealthio_persistence::open_pool(&app_data_dir.join("wildflower.sqlite"))
        .expect("open the server's database");
    let signing_key = SqliteGrantStore::new(pool)
        .expect("grant store")
        .active_signing_key()
        .expect("signing-key query")
        .expect("an active signing key");
    mint_access_token(
        &signing_key,
        &NewJwtArgs {
            client_id: "request-log-reader",
            scopes,
            ttl: chrono::Duration::minutes(5),
            issuer: server_origin,
            audience: Some(server_origin),
            patient: None,
        },
    )
    .expect("mint a client token")
}

/// The status of a `GET /requests` sent straight to the loopback port with
/// `bearer_token`.
async fn loopback_request_log_status(
    loopback_base_url: &Url,
    bearer_token: &str,
) -> reqwest::StatusCode {
    reqwest::Client::new()
        .get(loopback_base_url.join("requests").expect("requests URL"))
        .bearer_auth(bearer_token)
        .send()
        .await
        .expect("GET /requests reaches the server")
        .status()
}

/// `GET /requests` relayed to the loopback listener by a front run on this
/// machine, with `bearer_token` when given.
async fn forwarded_request_log_read(
    loopback_base_url: &Url,
    bearer_token: Option<&str>,
) -> reqwest::Response {
    let request = reqwest::Client::new()
        .get(loopback_base_url.join("requests").expect("requests URL"))
        .header("forwarded", FORWARDED);
    let request = match bearer_token {
        Some(bearer_token) => request.bearer_auth(bearer_token),
        None => request,
    };
    request
        .send()
        .await
        .expect("GET /requests reaches the server")
}

/// The status of a `GET /metadata` relayed from `192.0.2.1`: an
/// unauthenticated request the forwarded-request layer reports.
async fn forwarded_metadata_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    reqwest::Client::new()
        .get(loopback_base_url.join("metadata").expect("metadata URL"))
        .header("forwarded", FORWARDED)
        .send()
        .await
        .expect("a forwarded GET /metadata reaches the server")
        .status()
}

/// Whether the request log, read with `bearer_token`, holds a
/// `GET /metadata` relayed from `192.0.2.1`.
async fn request_log_holds_forwarded_metadata(loopback_base_url: &Url, bearer_token: &str) -> bool {
    let response = forwarded_request_log_read(loopback_base_url, Some(bearer_token)).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let page: Value = response.json().await.expect("a JSON request-log page");
    page["requests"]
        .as_array()
        .expect("a requests array")
        .iter()
        .any(|logged| logged["path"] == "/metadata" && logged["address"] == "192.0.2.1")
}

/// The composition root's request-log wiring: the forwarded-request layer feeds
/// the request log's writer, and `/requests` sits behind the authorization server bearer
/// gate, which hands the request log's scope check the caller's scopes.
#[tokio::test(flavor = "multi_thread")]
async fn the_request_log_records_forwarded_requests_behind_its_scope() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        tunnel_state_tx: watch::channel(None).0,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
        forwarded_request_tx,
    };
    let shutdown = CancellationToken::new();
    let serving = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
            observers,
            shutdown.clone(),
        ),
    )
    .await
    .expect("the server binds in time");
    let request_log_scopes = wildflowerhealthio_request_log::grantable_request_log_scopes()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let request_log_reader = client_token(app_data_dir.path(), SERVER_ORIGIN, &request_log_scopes);
    let other_servers_reader = client_token(
        app_data_dir.path(),
        OTHER_SERVER_ORIGIN,
        &request_log_scopes,
    );
    let apps_reader = client_token(
        app_data_dir.path(),
        SERVER_ORIGIN,
        &["wildflower/Apps.r".to_owned()],
    );

    assert_eq!(
        forwarded_metadata_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );

    // The writer records off the request path, so the row lands a moment after
    // the response; read until it does.
    tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
        while !request_log_holds_forwarded_metadata(&loopback_base_url, &request_log_reader).await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the forwarded request is logged in time");
    assert_eq!(
        forwarded_request_log_read(&loopback_base_url, Some(&apps_reader))
            .await
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        forwarded_request_log_read(&loopback_base_url, None)
            .await
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    // The token names the server's origin, not the origin a request was served
    // on, so it is accepted from a direct loopback caller as well as through
    // the front.
    assert_eq!(
        loopback_request_log_status(&loopback_base_url, &request_log_reader).await,
        reqwest::StatusCode::OK
    );
    // A token another server minted is refused, though it carries the scope and
    // this server's own key signed it.
    assert_eq!(
        forwarded_request_log_read(&loopback_base_url, Some(&other_servers_reader))
            .await
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        loopback_request_log_status(&loopback_base_url, &other_servers_reader).await,
        reqwest::StatusCode::UNAUTHORIZED
    );

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}

/// A direct-loopback caller is authenticated like any other: the loopback
/// listener presents no credential on its behalf, so a request with no bearer
/// is refused at every gated surface, whoever sits at the machine.
#[tokio::test(flavor = "multi_thread")]
async fn a_direct_loopback_request_without_a_bearer_is_unauthorized() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx: watch::channel(None).0,
        tunnel_state_tx: watch::channel(None).0,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
        forwarded_request_tx,
    };
    let shutdown = CancellationToken::new();
    let serving = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
            observers,
            shutdown.clone(),
        ),
    )
    .await
    .expect("the server binds in time");

    // The authorization server's admin surface, the request log, the database
    // catalogue, the apps and the FHIR API.
    for path in [
        "authorization/clients",
        "requests",
        "databases",
        "apps",
        "Patient",
    ] {
        let status = reqwest::Client::new()
            .get(loopback_base_url.join(path).expect("loopback URL"))
            .send()
            .await
            .unwrap_or_else(|error| panic!("GET /{path} reaches the server: {error}"))
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED, "GET /{path}");
    }

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}

/// What a visitor reaches the server's tunnel listener through: the channel
/// the tunnel hands its streams over on, and a TLS client trusting the
/// server's certificate.
struct TunnelClient {
    tunnel_stream_tx: mpsc::Sender<TunnelStream>,
    connector: TlsConnector,
}

impl TunnelClient {
    /// A client handing streams to `tunnel_stream_tx` and trusting
    /// `certificate`.
    fn new(
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        certificate: CertificateDer<'static>,
    ) -> Self {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate).expect("a root");
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Self {
            tunnel_stream_tx,
            connector: TlsConnector::from(Arc::new(config)),
        }
    }

    /// Hand the tunnel listener a visitor's connection, as the tunnel does,
    /// send `proxy_header` on it if given, then complete a TLS handshake
    /// naming `server_name`.
    async fn connect(
        &self,
        proxy_header: Option<&[u8]>,
        server_name: &str,
    ) -> std::io::Result<TlsStream<DuplexStream>> {
        let (mut visitor, tunnel_stream) = tokio::io::duplex(64 * 1024);
        self.tunnel_stream_tx
            .send(Box::new(tunnel_stream))
            .await
            .expect("the tunnel listener takes streams");
        if let Some(proxy_header) = proxy_header {
            visitor.write_all(proxy_header).await.expect("write header");
        }
        let server_name = ServerName::try_from(server_name.to_owned()).expect("a DNS name");
        self.connector.connect(server_name, visitor).await
    }

    /// Wait until the server's certificate is deployed: its cache is read in
    /// the background once the server is set up.
    async fn wait_for_certificate(&self) {
        tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
            while self.connect(None, DOMAIN).await.is_err() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the cached certificate is deployed in time");
    }
}

/// A self-signed certificate for [`DOMAIN`], cached in `certificate_dir`
/// as rustls-acme caches the one it orders from
/// [`TEST_CA`]. Valid for years, so the server
/// deploys it and orders nothing.
async fn cache_self_signed_certificate(certificate_dir: &Path) -> CertificateDer<'static> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key pair");
    let mut params = rcgen::CertificateParams::new(vec![DOMAIN.to_owned()]).expect("params");
    params.not_after = rcgen::date_time_ymd(2099, 1, 1);
    let certificate = params.self_signed(&key_pair).expect("self-signed");
    let cache_entry = [key_pair.serialize_pem(), certificate.pem()].concat();
    DirCache::new(certificate_dir)
        .store_cert(
            &[DOMAIN.to_owned()],
            TEST_CA.directory_url().as_str(),
            cache_entry.as_bytes(),
        )
        .await
        .expect("cache the certificate");
    certificate.der().clone()
}

/// Send `request` (raw HTTP/1.1, asking the server to close) through the
/// tunnel listener, after `proxy_header` if given, over TLS for the public
/// host. Returns the response's status code and body; `None` when the server
/// closes the connection without answering.
async fn tunnel_exchange(
    tunnel: &TunnelClient,
    proxy_header: Option<&[u8]>,
    request: &str,
) -> Option<(u16, String)> {
    let response = raw_tunnel_exchange(tunnel, proxy_header, request).await;
    let status = response.split(' ').nth(1)?.parse().ok()?;
    let (_, body) = response.split_once("\r\n\r\n")?;
    Some((status, body.to_owned()))
}

/// [`tunnel_exchange`]'s whole response, unparsed: empty when the server
/// closes the connection without answering.
async fn raw_tunnel_exchange(
    tunnel: &TunnelClient,
    proxy_header: Option<&[u8]>,
    request: &str,
) -> String {
    let Ok(mut tls_stream) = tunnel.connect(proxy_header, DOMAIN).await else {
        return String::new();
    };
    // A server that already closed the connection fails the write; the read
    // says so.
    let _ = tls_stream.write_all(request.as_bytes()).await;
    let mut response = Vec::new();
    let _ = tls_stream.read_to_end(&mut response).await;
    String::from_utf8(response).expect("utf-8 response")
}

/// A `GET path` addressed to `host` over a connection the server closes after
/// answering, with `extra_headers` (each ending in CRLF).
fn tunnel_get(path: &str, host: &str, extra_headers: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra_headers}Connection: close\r\n\r\n")
}

/// The served host, visitor address and status of the request reported next.
/// The report is sent before the response, so it is already queued once the
/// response has been read.
fn next_report(
    forwarded_request_rx: &mut mpsc::Receiver<ForwardedRequest>,
) -> (Option<String>, Option<String>, u16) {
    let forwarded_request = forwarded_request_rx
        .try_recv()
        .expect("the request was reported");
    (
        forwarded_request.served_host,
        forwarded_request.client_address,
        forwarded_request.status,
    )
}

/// A PROXY protocol v2 header for the visitor at `source`, as the relay
/// writes it.
fn proxy_header(source: &str) -> Vec<u8> {
    wildflowerhealthio_rathole_settings::proxy_header::proxy_header(
        source.parse().expect("source address"),
        "198.51.100.1:443".parse().expect("relay address"),
    )
    .expect("PROXY header")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_listener_serves_remote_requests_as_the_public_origin() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let certificate = cache_self_signed_certificate(&certificate_dir(server_dir.path())).await;
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, mut forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        tunnel_state_tx: watch::channel(None).0,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
        forwarded_request_tx,
    };
    let server = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        set_up(
            server_config(server_dir.path().to_owned(), loopback_base_url.clone()),
            observers,
        ),
    )
    .await
    .expect("the server sets up in time")
    .expect("the server sets up and binds");
    let tunnel = TunnelClient::new(server.tunnel_stream_tx(), certificate);
    let shutdown = CancellationToken::new();
    let serving = tokio::spawn(server.serve(shutdown.clone()));
    tunnel.wait_for_certificate().await;

    // The owner-gated `/apps` refuses a direct loopback caller with no bearer,
    // and nothing is reported.
    let loopback_apps = reqwest::get(loopback_base_url.join("apps").expect("apps URL"))
        .await
        .expect("GET /apps reaches the loopback listener");
    assert_eq!(loopback_apps.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(forwarded_request_rx.try_recv().is_err());

    // The same request through the tunnel, from a loopback-looking connection
    // with no `Forwarded`, is refused too. It is reported as served at the
    // domain, with no visitor address (no PROXY header).
    let (status, _) = tunnel_exchange(&tunnel, None, &tunnel_get("/apps", DOMAIN, ""))
        .await
        .expect("the tunnel listener answers");
    assert_eq!(status, 401);
    assert_eq!(
        next_report(&mut forwarded_request_rx),
        (Some(DOMAIN.to_owned()), None, 401),
        "a tunnel request is forwarded, for the domain"
    );

    // Discovery renders the public origin, even when the visitor sends a
    // `Forwarded` of its own naming another host and scheme.
    let (status, smart_configuration) = tunnel_exchange(
        &tunnel,
        None,
        &tunnel_get(
            "/.well-known/smart-configuration",
            DOMAIN,
            "Forwarded: for=203.0.113.9;host=evil.example.com;proto=http\r\n",
        ),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 200);
    let smart_configuration: Value =
        serde_json::from_str(&smart_configuration).expect("a JSON discovery document");
    assert_eq!(
        smart_configuration["token_endpoint"],
        format!("https://{DOMAIN}/oauth/token")
    );
    assert_eq!(
        next_report(&mut forwarded_request_rx),
        (Some(DOMAIN.to_owned()), None, 200),
        "the visitor's `Forwarded` is replaced"
    );

    // A TLS handshake naming another host fails, before any request.
    assert!(
        tunnel.connect(None, "other.example.com").await.is_err(),
        "no certificate for another host"
    );

    // A request naming a host other than the domain, over TLS for the
    // domain, is misdirected, and not reported.
    let (status, _) = tunnel_exchange(
        &tunnel,
        None,
        &tunnel_get("/metadata", "other.example.com", ""),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 421);
    assert!(forwarded_request_rx.try_recv().is_err());
    // A remote app can read the `421`: it carries the CORS headers.
    let response = raw_tunnel_exchange(
        &tunnel,
        None,
        &tunnel_get(
            "/metadata",
            "other.example.com",
            "Origin: https://app.example.com\r\n",
        ),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 421 "), "{response}");
    assert!(
        response.contains("\r\naccess-control-allow-origin: "),
        "{response}"
    );

    // A token for this server is accepted through the tunnel listener too, and
    // one another server minted is refused there as well.
    let request_log_scopes = wildflowerhealthio_request_log::grantable_request_log_scopes()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for (server_origin, expected_status) in [(SERVER_ORIGIN, 200), (OTHER_SERVER_ORIGIN, 401)] {
        let request_log_reader =
            client_token(server_dir.path(), server_origin, &request_log_scopes);
        let (status, _) = tunnel_exchange(
            &tunnel,
            None,
            &tunnel_get(
                "/requests",
                DOMAIN,
                &format!("Authorization: Bearer {request_log_reader}\r\n"),
            ),
        )
        .await
        .expect("the tunnel listener answers");
        assert_eq!(
            status, expected_status,
            "a token minted for {server_origin}"
        );
        assert_eq!(
            next_report(&mut forwarded_request_rx),
            (Some(DOMAIN.to_owned()), None, expected_status)
        );
    }

    // A PROXY header names the visitor to the request log, and is stripped
    // before HTTP.
    for (source, client_address) in [
        ("192.0.2.1:4711", "192.0.2.1"),
        ("[2001:db8::1]:4711", "[2001:db8::1]"),
    ] {
        let (status, _) = tunnel_exchange(
            &tunnel,
            Some(&proxy_header(source)),
            &tunnel_get("/metadata", DOMAIN, ""),
        )
        .await
        .expect("the tunnel listener answers after a PROXY header");
        assert_eq!(status, 200);
        assert_eq!(
            next_report(&mut forwarded_request_rx),
            (
                Some(DOMAIN.to_owned()),
                Some(client_address.to_owned()),
                200
            )
        );
    }

    // A malformed PROXY header closes the connection unanswered, and the
    // listener keeps serving.
    let mut malformed = proxy_header("192.0.2.1:4711");
    malformed[ppp::v2::PROTOCOL_PREFIX.len()] = 0x11;
    assert_eq!(
        tunnel_exchange(
            &tunnel,
            Some(&malformed),
            &tunnel_get("/metadata", DOMAIN, "")
        )
        .await,
        None
    );
    assert!(forwarded_request_rx.try_recv().is_err());
    let (status, _) = tunnel_exchange(&tunnel, None, &tunnel_get("/metadata", DOMAIN, ""))
        .await
        .expect("the tunnel listener still answers");
    assert_eq!(status, 200);

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}

/// `GET /oauth/authorize` for the seeded Health Viewer client with `launch`,
/// relayed to the loopback listener by a front run on this machine, as the
/// app's browser would reach it; the `Location` it redirects to.
async fn authorize_health_viewer_launch(
    loopback_base_url: &Url,
    launch: &str,
    aud: &str,
) -> String {
    let mut authorize_url = loopback_base_url
        .join("oauth/authorize")
        .expect("authorize URL");
    authorize_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("code_challenge_method", "S256")
        .append_pair("client_id", "474e103de61f9141c4b640d59bfa130e")
        .append_pair("scope", "openid system/Observation.rs")
        .append_pair(
            "code_challenge",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )
        .append_pair("redirect_uri", "https://wildflowerhealth.io/health-viewer/")
        .append_pair("state", "xyz")
        .append_pair("launch", launch)
        .append_pair("aud", aud);
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("an HTTP client")
        .get(authorize_url)
        .header("forwarded", FORWARDED)
        .send()
        .await
        .expect("GET /oauth/authorize reaches the server");
    assert_eq!(response.status(), reqwest::StatusCode::FOUND);
    response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|location| location.to_str().ok())
        .expect("a Location")
        .to_owned()
}

/// The composition root's launch wiring: `POST /apps/{id}` for a SMART app
/// answers its launch URL with the FHIR base as `iss` and a `launch` the authorization server
/// minted for the app's client, and that `launch` parks one authorization
/// request at `/oauth/authorize`, then is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_smart_launch_is_minted_for_its_client_and_consumed_once() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        tunnel_state_tx: watch::channel(None).0,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
        forwarded_request_tx,
    };
    let shutdown = CancellationToken::new();
    let serving = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
            observers,
            shutdown.clone(),
        ),
    )
    .await
    .expect("the server binds in time");
    let launcher = client_token(
        app_data_dir.path(),
        SERVER_ORIGIN,
        &[
            "system/*.cruds".to_owned(),
            "wildflower/*.cruds".to_owned(),
            "wildflower/launch".to_owned(),
        ],
    );

    let launched = reqwest::Client::new()
        .post(
            loopback_base_url
                .join("apps/health-viewer")
                .expect("launch URL"),
        )
        .header("forwarded", FORWARDED)
        .bearer_auth(&launcher)
        .send()
        .await
        .expect("POST /apps/health-viewer reaches the server");
    assert_eq!(launched.status(), reqwest::StatusCode::OK);
    let launch_url = Url::parse(
        launched.json::<Value>().await.expect("a launch body")["url"]
            .as_str()
            .expect("a launch URL"),
    )
    .expect("the launch URL parses");
    let launch_param = |name: &str| {
        launch_url
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| panic!("{launch_url} carries {name}"))
    };
    let (launch, iss) = (launch_param("launch"), launch_param("iss"));
    assert_eq!(iss, SERVER_ORIGIN);
    assert!(!launch.is_empty());

    let parked = authorize_health_viewer_launch(&loopback_base_url, &launch, &iss).await;
    assert!(
        parked.ends_with("/wait"),
        "the launch parks a request for the Owner, got {parked}"
    );
    assert_eq!(
        authorize_health_viewer_launch(&loopback_base_url, &launch, &iss).await,
        "https://wildflowerhealth.io/health-viewer/?error=invalid_request&state=xyz",
        "the launch works once"
    );

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}

/// Every URL the SMART discovery document advertises on the origin it was
/// served on is a route the server answers: requested without a token, none
/// is a `404`. The authorization API's base names no resource of its own, so
/// it is walked through its `session` route. The one URL off that origin is
/// the `management_endpoint`, the hosted Wildflower Authorization app pointed
/// at the `issuer`.
#[tokio::test(flavor = "multi_thread")]
async fn every_endpoint_smart_discovery_advertises_is_routed() {
    let server = UiServer::start().await;
    let served_origin = server.loopback_base_url.origin().ascii_serialization();
    let discovery: Value = server
        .browser
        .get(
            server
                .loopback_base_url
                .join(".well-known/smart-configuration")
                .expect("discovery URL"),
        )
        .send()
        .await
        .expect("GET the discovery document")
        .json()
        .await
        .expect("a JSON discovery document");
    assert_eq!(discovery["issuer"], SERVER_ORIGIN);
    assert_eq!(
        discovery["management_endpoint"],
        "https://authorization.test/authorization/?iss=https%3A%2F%2Ftest.relay.invalid"
    );

    let mut walked = Vec::new();
    for (field, value) in discovery.as_object().expect("a JSON object") {
        if field == "issuer" || field == "management_endpoint" {
            continue;
        }
        let Some(url) = value.as_str().and_then(|value| Url::parse(value).ok()) else {
            continue;
        };
        assert_eq!(
            url.origin().ascii_serialization(),
            served_origin,
            "{field} is on the origin discovery was served on"
        );
        let route = if field == "wildflower_authorization_api" {
            url.join("session").expect("the API's session route")
        } else {
            url
        };
        let status = server
            .browser
            .get(route.clone())
            .send()
            .await
            .unwrap_or_else(|error| panic!("GET {route}: {error}"))
            .status();
        assert_ne!(
            status,
            reqwest::StatusCode::NOT_FOUND,
            "{field} ({route}) is routed"
        );
        walked.push(field.as_str());
    }
    walked.sort_unstable();
    assert_eq!(
        walked,
        [
            "authorization_endpoint",
            "jwks_uri",
            "token_endpoint",
            "wildflower_authorization_api"
        ]
    );

    server.shut_down().await;
}

/// A request a browser on the server's public origin sends, as the tunnel front
/// stamps it.
const PUBLIC_BROWSER_FORWARDED: &str = "for=192.0.2.1;host=test.relay.invalid;proto=https";

/// The `name=value` pairs a response's `Set-Cookie` headers set.
fn cookies_set_by(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|cookie| cookie.split(';').next())
        .map(str::to_owned)
        .collect()
}

/// The response's `Location`.
fn location_of(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|location| location.to_str().ok())
        .expect("a Location")
        .to_owned()
}

/// `url`'s path and query, sent to the loopback listener instead.
fn on_loopback(loopback_base_url: &Url, url: &str) -> Url {
    let url = Url::parse(url).expect("an absolute URL");
    let mut on_loopback = loopback_base_url.join(url.path()).expect("loopback URL");
    on_loopback.set_query(url.query());
    on_loopback
}

/// A composed server serving over a temporary folder, for a browser to use
/// its FHIR web UI.
struct UiServer {
    app_data_dir: tempfile::TempDir,
    loopback_base_url: Url,
    /// Mints the codes the host signs a browser in as the Owner with.
    same_device_sign_in_code_minter:
        wildflowerhealthio_authorization_server::SameDeviceSignInCodeMinter,
    browser: reqwest::Client,
    shutdown: CancellationToken,
    serving: JoinHandle<anyhow::Result<()>>,
}

impl UiServer {
    /// Set a server up over a fresh folder and serve it, with a browser that
    /// doesn't follow redirects.
    async fn start() -> Self {
        let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
        let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
            .expect("loopback base URL");
        let (server_health_tx, _server_health_rx) = watch::channel(None);
        let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
        let observers = ServerObservers {
            server_health_tx,
            tunnel_state_tx: watch::channel(None).0,
            certificate_tx: watch::channel(None).0,
            pending_consent_tx: watch::channel(None).0,
            forwarded_request_tx,
        };
        let shutdown = CancellationToken::new();
        let server = tokio::time::timeout(
            LIFECYCLE_TIMEOUT,
            set_up(
                server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
                observers,
            ),
        )
        .await
        .expect("the server binds in time")
        .expect("the server sets up and binds");
        let same_device_sign_in_code_minter = server.same_device_sign_in_code_minter();
        let serving = tokio::spawn(server.serve(shutdown.clone()));
        let browser = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("an HTTP client");
        Self {
            app_data_dir,
            loopback_base_url,
            same_device_sign_in_code_minter,
            browser,
            shutdown,
            serving,
        }
    }

    /// Sign in to the UI as its seeded client, the Owner approving, and return
    /// the session cookie (`name=value`) the UI's callback sets: `/ui/login`
    /// sends the browser to the authorization server's authorize endpoint, the authorization server parks
    /// the request for the Owner, and the UI redeems the approved code.
    async fn sign_in(&self) -> String {
        let login = self
            .browser
            .get(self.loopback_base_url.join("ui/login").expect("login URL"))
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .send()
            .await
            .expect("GET /ui/login reaches the server");
        let authorize_url = location_of(&login);
        assert!(
            authorize_url.starts_with(&format!("{SERVER_ORIGIN}/oauth/authorize?")),
            "sent to the authorization server's authorize endpoint, got {authorize_url}"
        );
        let pending_cookies = cookies_set_by(&login).join("; ");

        let parked = self
            .browser
            .get(on_loopback(&self.loopback_base_url, &authorize_url))
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .send()
            .await
            .expect("GET /oauth/authorize reaches the server");
        let wait_page = location_of(&parked);
        let request_id = wait_page
            .strip_prefix("authorize/")
            .and_then(|rest| rest.strip_suffix("/wait"))
            .unwrap_or_else(|| panic!("parked for the Owner, got {wait_page}"));
        let owner_scopes: Vec<String> =
            wildflowerhealthio_authorization_server::WILDFLOWER_WIDEST_SCOPES
                .iter()
                .map(ToString::to_string)
                .collect();
        let owner_token = client_token(self.app_data_dir.path(), SERVER_ORIGIN, &owner_scopes);
        let approved: Value = self
            .browser
            .post(
                self.loopback_base_url
                    .join(&format!(
                        "authorization/oauth-consents/{request_id}/approve"
                    ))
                    .expect("approve URL"),
            )
            .bearer_auth(owner_token)
            .json(&serde_json::json!({
                "approvedScopes": ["user/*.cruds"],
                "patient": null,
                "acknowledgedRegistration": true,
            }))
            .send()
            .await
            .expect("the approval reaches the server")
            .json()
            .await
            .expect("a consent result");
        let callback_url = approved["redirect"]
            .as_str()
            .unwrap_or_else(|| panic!("approved with a redirect, got {approved}"));
        assert!(callback_url.starts_with(&format!("{SERVER_ORIGIN}/ui/callback?")));

        let callback = self
            .browser
            .get(on_loopback(&self.loopback_base_url, callback_url))
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .header("cookie", &pending_cookies)
            .send()
            .await
            .expect("GET /ui/callback reaches the server");
        cookies_set_by(&callback)
            .into_iter()
            .find(|cookie| cookie.starts_with(&format!("{}=", helios_auth::SESSION_COOKIE)))
            .unwrap_or_else(|| panic!("a session cookie, after {}", callback.status()))
    }

    /// A request the UI's own page sends to `path`: same-origin, on the public
    /// origin, carrying `session_cookie` when there is one.
    fn ui_request(
        &self,
        method: reqwest::Method,
        path: &str,
        session_cookie: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let request = self
            .browser
            .request(
                method,
                self.loopback_base_url.join(path).expect("UI call URL"),
            )
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .header("sec-fetch-site", "same-origin")
            .header("origin", SERVER_ORIGIN);
        match session_cookie {
            Some(session_cookie) => request.header("cookie", session_cookie),
            None => request,
        }
    }

    /// Cancel the server and wait for `serve` to return, handing back its
    /// folder.
    async fn shut_down(self) -> tempfile::TempDir {
        self.shutdown.cancel();
        tokio::time::timeout(LIFECYCLE_TIMEOUT, self.serving)
            .await
            .expect("serve returns in time once cancelled")
            .expect("the serve task doesn't panic")
            .expect("a cancelled serve returns Ok");
        self.app_data_dir
    }
}

/// The FHIR web UI's sign-in, end to end through the composed server: its
/// assets are served without a session, the UI sends the browser to
/// the authorization server's authorize endpoint as its seeded client, the Owner approves
/// it, the UI redeems the code on its callback and sets its session cookie,
/// and a FHIR read carrying only that cookie is served, while the same read
/// without it is refused at the gate.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_signs_in_through_authorization_server_and_reads_fhir_on_its_session() {
    let server = UiServer::start().await;

    // The UI's assets are served before sign-in, past the gate; a `/ui` path
    // the UI doesn't serve falls through to the gate.
    let ui_status = |path: &str| {
        server
            .browser
            .get(server.loopback_base_url.join(path).expect("UI URL"))
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .send()
    };
    assert_eq!(
        ui_status("ui/assets/app.css")
            .await
            .expect("GET /ui/assets/app.css reaches the server")
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        ui_status("ui/no-such-page")
            .await
            .expect("GET /ui/no-such-page reaches the server")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let session_cookie = server.sign_in().await;

    // A FHIR read carrying only the session cookie is served; without it, the
    // gate refuses it.
    let signed_in = server
        .ui_request(reqwest::Method::GET, "Patient", Some(&session_cookie))
        .send()
        .await
        .expect("GET /Patient reaches the server");
    assert_eq!(signed_in.status(), reqwest::StatusCode::OK);
    assert_eq!(
        signed_in.json::<Value>().await.expect("a Bundle")["resourceType"],
        "Bundle"
    );
    assert_eq!(
        server
            .ui_request(reqwest::Method::GET, "Patient", None)
            .send()
            .await
            .expect("GET /Patient reaches the server")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    server.shut_down().await;
}

/// The same-device sign-in of an Owner browser, end to end through the
/// composed server: a code the host mints signs a browser in and sends it on,
/// and its `__Host-owner_browser_session` cookie alone then reads
/// `GET /authorization/session` as the Owner from the server's own pages. Sent
/// with the FHIR web UI's `hfs_session` too, the UI's session wins, unless
/// the page asks for the Owner browser session with `Wildflower-Session`. A write
/// carrying the cookie from another server's page is refused; one from the
/// server's own page goes through on it, here revoking the session's own
/// `jti`, after which the cookie is skipped, so the request gets `401`, and
/// the response clears it.
#[tokio::test(flavor = "multi_thread")]
async fn the_owner_signs_in_with_a_code_and_is_served_on_the_cookie() {
    let server = UiServer::start().await;

    let mut sign_in_url = server
        .loopback_base_url
        .join("oauth/sign-in")
        .expect("sign-in URL");
    sign_in_url
        .query_pairs_mut()
        .append_pair("code", &server.same_device_sign_in_code_minter.mint())
        .append_pair("next", "/ui");
    let signed_in = server
        .browser
        .get(sign_in_url)
        .header("forwarded", PUBLIC_BROWSER_FORWARDED)
        .send()
        .await
        .expect("GET /oauth/sign-in reaches the server");
    assert_eq!(signed_in.status(), reqwest::StatusCode::SEE_OTHER);
    assert_eq!(location_of(&signed_in), "/ui");
    let owner_cookie = cookies_set_by(&signed_in)
        .into_iter()
        .find(|cookie| {
            cookie.starts_with(&format!(
                "{}=",
                wildflowerhealthio_authorization_server::OWNER_BROWSER_SESSION_COOKIE
            ))
        })
        .expect("the Owner browser session cookie");
    let session = || async {
        server
            .ui_request(
                reqwest::Method::GET,
                "authorization/session",
                Some(&owner_cookie),
            )
            .send()
            .await
            .expect("GET /authorization/session reaches the server")
    };

    let signed_in_session = session().await;
    assert_eq!(signed_in_session.status(), reqwest::StatusCode::OK);
    assert_eq!(
        signed_in_session.json::<Value>().await.expect("a session")["scopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::owner_scopes())
    );

    let ui_cookie = server.sign_in().await;
    let with_both_cookies = server
        .ui_request(
            reqwest::Method::GET,
            "authorization/session",
            Some(&format!("{owner_cookie}; {ui_cookie}")),
        )
        .send()
        .await
        .expect("GET /authorization/session reaches the server");
    assert_eq!(with_both_cookies.status(), reqwest::StatusCode::OK);
    assert_eq!(
        with_both_cookies.json::<Value>().await.expect("a session")["scopes"],
        serde_json::json!(["user/*.cruds"]),
        "the FHIR web UI's session wins"
    );
    let asking_for_the_owner = server
        .ui_request(
            reqwest::Method::GET,
            "authorization/session",
            Some(&format!("{owner_cookie}; {ui_cookie}")),
        )
        .header(
            wildflowerhealthio_authorization_server::SESSION_HEADER,
            wildflowerhealthio_authorization_server::OWNER_BROWSER_SESSION_HEADER_VALUE,
        )
        .send()
        .await
        .expect("GET /authorization/session reaches the server");
    assert_eq!(asking_for_the_owner.status(), reqwest::StatusCode::OK);
    assert_eq!(
        asking_for_the_owner
            .json::<Value>()
            .await
            .expect("a session")["scopes"],
        serde_json::json!(owner_scopes),
        "a page asking for the Owner browser session gets it"
    );

    let owner_token = owner_cookie
        .split_once('=')
        .map(|(_, token)| token)
        .expect("a cookie value");
    let payload = owner_token.split('.').nth(1).expect("a JWT payload");
    let claims: Value = serde_json::from_slice(
        &wildflowerhealthio_authorization_server::crypto_util::base64::url_safe_no_pad_decode(
            payload,
        )
        .expect("base64url"),
    )
    .expect("JSON claims");
    let revoke_the_session = serde_json::json!({
        "jti": claims["jti"],
        "expiresAt": (chrono::Utc::now() + chrono::Duration::hours(8)).to_rfc3339(),
    });
    let revocations_url = server
        .loopback_base_url
        .join("authorization/revocations")
        .expect("revocations URL");

    let from_another_server = server
        .browser
        .post(revocations_url)
        .header("forwarded", PUBLIC_BROWSER_FORWARDED)
        .header("sec-fetch-site", "same-site")
        .header("origin", OTHER_SERVER_ORIGIN)
        .header("cookie", &owner_cookie)
        .json(&revoke_the_session)
        .send()
        .await
        .expect("the revocation reaches the server");
    assert_eq!(from_another_server.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(session().await.status(), reqwest::StatusCode::OK);

    let from_its_own_page = server
        .ui_request(
            reqwest::Method::POST,
            "authorization/revocations",
            Some(&owner_cookie),
        )
        .json(&revoke_the_session)
        .send()
        .await
        .expect("the revocation reaches the server");
    assert_eq!(from_its_own_page.status(), reqwest::StatusCode::NO_CONTENT);
    let signed_out = session().await;
    assert_eq!(signed_out.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(
        cookies_set_by(&signed_out),
        [format!(
            "{}=",
            wildflowerhealthio_authorization_server::OWNER_BROWSER_SESSION_COOKIE
        )],
        "the ended session's cookie is cleared"
    );

    server.shut_down().await;
}

/// A page on another server behind the same relay is same-site to this one,
/// so its form posts carry the UI's `SameSite=Lax` session cookie. Neither a
/// FHIR write nor a write through the UI's own routes, which sit outside the
/// gate, rides it: both are refused before they reach HFS.
#[tokio::test(flavor = "multi_thread")]
async fn another_server_s_page_cannot_write_on_the_ui_s_session() {
    let server = UiServer::start().await;
    let session_cookie = server.sign_in().await;
    let user_settings = || async {
        server
            .ui_request(
                reqwest::Method::GET,
                "_user/settings",
                Some(&session_cookie),
            )
            .send()
            .await
            .expect("GET /_user/settings reaches the server")
            .text()
            .await
            .expect("the settings")
    };
    let settings_before = user_settings().await;

    // The body each would send without a preflight: JSON as `text/plain` to
    // the FHIR API, the UI's own form encoding to its route, which writes the
    // user's settings.
    for (path, content_type, body) in [
        ("Patient", "text/plain", r#"{"resourceType":"Patient"}"#),
        (
            "ui/version",
            "application/x-www-form-urlencoded",
            "version=R4",
        ),
    ] {
        let form_post = server
            .browser
            .post(
                server
                    .loopback_base_url
                    .join(path)
                    .expect("form action URL"),
            )
            .header("forwarded", PUBLIC_BROWSER_FORWARDED)
            .header("sec-fetch-site", "same-site")
            .header("origin", OTHER_SERVER_ORIGIN)
            .header("content-type", content_type)
            .header("cookie", &session_cookie)
            .body(body)
            .send()
            .await
            .expect("the form post reaches the server");
        assert_eq!(
            form_post.status(),
            reqwest::StatusCode::FORBIDDEN,
            "POST /{path}"
        );
    }

    let patients = server
        .ui_request(reqwest::Method::GET, "Patient", Some(&session_cookie))
        .send()
        .await
        .expect("GET /Patient reaches the server")
        .json::<Value>()
        .await
        .expect("a Bundle");
    assert_eq!(
        patients["entry"],
        serde_json::json!([]),
        "no Patient was created: {patients}"
    );
    assert_eq!(
        user_settings().await,
        settings_before,
        "the UI's settings are unchanged"
    );

    server.shut_down().await;
}

/// The FHIR web UI's per-user settings, on its session cookie: a document the
/// UI puts is the one it gets back, the gate refuses the same read without
/// the cookie, and the document is stored in the health data's own sqlite
/// file.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_keeps_its_settings_in_the_health_data_file() {
    let server = UiServer::start().await;
    let session_cookie = server.sign_in().await;
    let settings = serde_json::json!({ "theme": "dark" });

    let put = server
        .ui_request(
            reqwest::Method::PUT,
            "_user/settings",
            Some(&session_cookie),
        )
        .json(&settings)
        .send()
        .await
        .expect("PUT /_user/settings reaches the server");
    assert_eq!(put.status(), reqwest::StatusCode::OK);
    let got = server
        .ui_request(
            reqwest::Method::GET,
            "_user/settings",
            Some(&session_cookie),
        )
        .send()
        .await
        .expect("GET /_user/settings reaches the server");
    assert_eq!(got.status(), reqwest::StatusCode::OK);
    assert_eq!(
        got.json::<Value>().await.expect("a JSON document"),
        settings
    );
    assert_eq!(
        server
            .ui_request(reqwest::Method::GET, "_user/settings", None)
            .send()
            .await
            .expect("GET /_user/settings reaches the server")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let app_data_dir = server.shut_down().await;
    let health_data = rusqlite::Connection::open(app_data_dir.path().join("health-data.sqlite"))
        .expect("the health data's sqlite file opens");
    let stored: Vec<u8> = health_data
        .query_row("SELECT data FROM user_settings", [], |row| row.get(0))
        .expect("one settings document in the health data's file");
    assert_eq!(
        serde_json::from_slice::<Value>(&stored).expect("stored as JSON"),
        settings
    );
}

/// The FHIR web UI's bulk export pages, signed in: its list of jobs and its
/// form for a new one are offered, not turned off for want of a settings
/// store to track the jobs in.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_offers_bulk_export() {
    let server = UiServer::start().await;
    let session_cookie = server.sign_in().await;
    let page_at = |path: &'static str| {
        let request = server.ui_request(reqwest::Method::GET, path, Some(&session_cookie));
        async move {
            let page = request
                .send()
                .await
                .unwrap_or_else(|error| panic!("GET /{path} reaches the server: {error}"));
            assert_eq!(page.status(), reqwest::StatusCode::OK, "GET /{path}");
            page.text().await.expect("an HTML page")
        }
    };

    let jobs_page = page_at("ui/bulk-export").await;
    assert!(
        jobs_page.contains("No exports yet."),
        "the list of jobs is offered, got {jobs_page}"
    );
    let new_export_page = page_at("ui/bulk-export/new").await;
    assert!(
        new_export_page.contains(r#"action="/ui/bulk-export""#),
        "the form for a new export is offered, got {new_export_page}"
    );

    server.shut_down().await;
}

/// A bulk `$export` on the UI's session, end to end: the server accepts it,
/// its worker runs it to a manifest, the manifest's file downloads on the same
/// session with the Patient the session wrote, and the file is staged in the
/// server's `fhir-exports` folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_bulk_export_runs_and_its_files_download() {
    let server = UiServer::start().await;
    let session_cookie = server.sign_in().await;

    let created = server
        .ui_request(reqwest::Method::POST, "Patient", Some(&session_cookie))
        .header("content-type", "application/fhir+json")
        .json(&serde_json::json!({
            "resourceType": "Patient",
            "name": [{ "family": "Exported" }],
        }))
        .send()
        .await
        .expect("POST /Patient reaches the server");
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let patient_id = created.json::<Value>().await.expect("the created Patient")["id"]
        .as_str()
        .expect("an id")
        .to_owned();

    let kickoff = server
        .ui_request(reqwest::Method::GET, "$export", Some(&session_cookie))
        .header("accept", "application/fhir+json")
        .header("prefer", "respond-async")
        .send()
        .await
        .expect("GET /$export reaches the server");
    assert_eq!(kickoff.status(), reqwest::StatusCode::ACCEPTED);
    let status_url = kickoff
        .headers()
        .get(reqwest::header::CONTENT_LOCATION)
        .and_then(|location| location.to_str().ok())
        .expect("a Content-Location to poll")
        .to_owned();

    let manifest: Value = tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
        loop {
            let status = server
                .browser
                .get(on_loopback(&server.loopback_base_url, &status_url))
                .header("forwarded", PUBLIC_BROWSER_FORWARDED)
                .header("sec-fetch-site", "same-origin")
                .header("cookie", &session_cookie)
                .send()
                .await
                .expect("the status poll reaches the server");
            match status.status() {
                reqwest::StatusCode::ACCEPTED => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                reqwest::StatusCode::OK => {
                    break status.json().await.expect("a manifest");
                }
                other => panic!("the export fails: {other} {:?}", status.text().await),
            }
        }
    })
    .await
    .expect("the export finishes in time");

    let patient_file_url = manifest["output"]
        .as_array()
        .expect("output files")
        .iter()
        .find(|file| file["type"] == "Patient")
        .and_then(|file| file["url"].as_str())
        .unwrap_or_else(|| panic!("a Patient file, in {manifest}"))
        .to_owned();
    assert!(
        patient_file_url.starts_with(&format!("{SERVER_ORIGIN}/export-file/")),
        "downloaded from the server's public origin, got {patient_file_url}"
    );
    let download = server
        .browser
        .get(on_loopback(&server.loopback_base_url, &patient_file_url))
        .header("forwarded", PUBLIC_BROWSER_FORWARDED)
        .header("sec-fetch-site", "same-origin")
        .header("cookie", &session_cookie)
        .send()
        .await
        .expect("the download reaches the server");
    assert_eq!(download.status(), reqwest::StatusCode::OK);
    let exported_ids: Vec<String> = download
        .text()
        .await
        .expect("NDJSON")
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).expect("a JSON resource")["id"]
                .as_str()
                .expect("an id")
                .to_owned()
        })
        .collect();
    assert_eq!(exported_ids, vec![patient_id]);

    let app_data_dir = server.shut_down().await;
    let staged_files = walk_files(&app_data_dir.path().join("fhir-exports"));
    assert!(
        staged_files.iter().any(|file| file
            .extension()
            .is_some_and(|extension| extension == "ndjson")),
        "the export's files are staged in fhir-exports, found {staged_files:?}"
    );
}

/// Every file under `dir`, at any depth.
fn walk_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{} reads: {error}", dir.display()))
        .map(|entry| entry.expect("a directory entry").path())
        .flat_map(|path| {
            if path.is_dir() {
                walk_files(&path)
            } else {
                vec![path]
            }
        })
        .collect()
}
