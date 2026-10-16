//! The server's lifecycle: `set_up` creates the server's folder and opens its
//! databases there, and cancelling `serve`'s shutdown token makes it return
//! `Ok`. A second server then sets up over the same folder and the same host
//! channels, and answers `/health`. The server binds no port: two run side by
//! side, each answering only through its own tunnel listener. While serving,
//! the host's observers see its tunnel's state, and the request log records
//! each forwarded request and serves it back on
//! `/requests` to a token holding the request log's read scope — a token
//! naming the server's origin as `iss` and `aud`, while one another server
//! minted is refused.
//!
//! The tunnel listener is the server's one listener, and every request here
//! goes through it, over TLS with the certificate cached for the server's
//! domain: its connections are held to the server's domain by their SNI and
//! their requests by their `Host`, are served as the public origin whatever
//! `Forwarded` or spelling of the `Host` they carry, and name the visitor from
//! a PROXY protocol v2 header. The `/health` the reachability monitor asks
//! through the relay is answered there, and logged.
//!
//! A SMART app's launch carries a `launch` the apps slice mints through
//! the authorization server, which the app's `/oauth/authorize` consumes once.
//! A visitor that starts authorization requests faster than its allowance is
//! answered `429`, and the request log records it.
//! The FHIR API takes an Owner browser's session cookie as its bearer, which
//! HFS checks against the authorization server's keys in process.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::header::{self, HeaderMap};
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
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
use wildflowerhealthio_request_log::domain::request_log::RequestLogFilter;
use wildflowerhealthio_request_log::domain::RequestLogStore;
use wildflowerhealthio_request_log::SqliteRequestLogStore;
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::health_check::{
    ComponentType, HealthReport, HealthStatus,
};
use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_shared_structures::request_caller::ForwardedRequest;
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;
use wildflowerhealthio_tunnel::{TunnelState, TunnelStream};
use wildflowerhealthio_wildflower_server::{
    set_up, CertificateAuthority, DeviceCertificateConfig, ServerObservers, WildflowerServer,
    WildflowerServerConfig,
};

/// The server's domain: the host every tunnel request must name. No relay
/// serves it, so the reachability monitor never reaches the server.
const DOMAIN: &str = "test.relay.invalid";

/// The server's origin, from [`DOMAIN`]: the `iss` and `aud` of every
/// token the server accepts.
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

fn server_config(server_dir: PathBuf) -> WildflowerServerConfig {
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
        launcher_url: Url::parse("https://launcher.test/launcher/").expect("launcher URL"),
        authorization_url: Url::parse("https://authorization.test/authorization/")
            .expect("authorization URL"),
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
        runtime: ServerRuntimeConfig { server_dir },
    }
}

/// The server's certificate folder, in its folder `server_dir`.
fn certificate_dir(server_dir: &Path) -> PathBuf {
    server_dir.join("certificates")
}

/// Host channels whose receivers are dropped.
fn observers() -> ServerObservers {
    ServerObservers {
        server_health_tx: watch::channel(None).0,
        tunnel_state_tx: watch::channel(None).0,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
    }
}

/// The request log of the server in `server_dir`, read straight from its
/// database as the forwarded-request layer's reports land there.
struct LoggedRequests {
    store: SqliteRequestLogStore,
    /// The id of the newest request read so far.
    newest_read: i64,
}

impl LoggedRequests {
    /// The request log in `server_dir`, as read from now on: what it already
    /// holds is passed over.
    fn of(server_dir: &Path) -> Self {
        // The server's shared database (`WILDFLOWER_DB` in `set_up`).
        let pool = wildflowerhealthio_persistence::open_pool(&server_dir.join("wildflower.sqlite"))
            .expect("open the server's database");
        let store = SqliteRequestLogStore::new(pool).expect("request-log store");
        let mut logged_requests = Self {
            store,
            newest_read: 0,
        };
        logged_requests.newest_read = logged_requests.unread().first().map_or(0, |(id, _)| *id);
        logged_requests
    }

    /// The requests logged since the newest read, newest first, with their ids.
    fn unread(&self) -> Vec<(i64, ForwardedRequest)> {
        self.store
            .requests_page(&RequestLogFilter::default())
            .expect("read the request log")
            .requests
            .into_iter()
            .filter(|logged| logged.id > self.newest_read)
            .map(|logged| (logged.id, logged.request))
            .collect()
    }

    /// The next request logged, waiting for it. The log keeps the order the
    /// requests were answered in, so a request answered before it would be
    /// logged by then: it must be the only one unread.
    async fn next(&mut self) -> ForwardedRequest {
        let mut unread = tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
            loop {
                let unread = self.unread();
                if !unread.is_empty() {
                    return unread;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the request is logged in time");
        assert_eq!(unread.len(), 1, "exactly one request logged: {unread:?}");
        let (id, forwarded_request) = unread.remove(0);
        self.newest_read = id;
        forwarded_request
    }
}

/// Cache a certificate for the server in `server_dir`, set the server up
/// there and spawn `serve`, and wait until its tunnel listener answers TLS.
/// Returns the client a visitor reaches it through, the server's handles
/// taken before serving, and the serving task.
async fn start_serving(
    server_dir: &Path,
    observers: ServerObservers,
    shutdown: CancellationToken,
) -> (TunnelClient, ServerHandles, JoinHandle<anyhow::Result<()>>) {
    let certificate = cache_self_signed_certificate(&certificate_dir(server_dir)).await;
    let server = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        set_up(server_config(server_dir.to_owned()), observers),
    )
    .await
    .expect("the server sets up in time")
    .expect("the server sets up");
    let tunnel = TunnelClient::new(server.tunnel_stream_tx(), certificate);
    let handles = ServerHandles::of(&server);
    let serving = tokio::spawn(server.serve(shutdown));
    tunnel.wait_for_certificate().await;
    (tunnel, handles, serving)
}

/// What a test keeps of a [`WildflowerServer`] once it serves.
struct ServerHandles {
    /// Mints the codes the host signs a browser in as the Owner with.
    same_device_sign_in_code_minter:
        wildflowerhealthio_authorization_server::SameDeviceSignInCodeMinter,
}

impl ServerHandles {
    fn of(server: &WildflowerServer) -> Self {
        Self {
            same_device_sign_in_code_minter: server.same_device_sign_in_code_minter(),
        }
    }
}

/// Wait for `serving` to return once `shutdown` is cancelled.
async fn shut_down(shutdown: &CancellationToken, serving: JoinHandle<anyhow::Result<()>>) {
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

    /// Send `request` through the tunnel listener on a fresh connection, over
    /// TLS for the domain, and read the whole response.
    async fn send(&self, request: Request<Full<Bytes>>) -> TunnelResponse {
        self.send_from(None, request).await
    }

    /// [`Self::send`], from the visitor `proxy_header` names when given.
    async fn send_from(
        &self,
        proxy_header: Option<&[u8]>,
        request: Request<Full<Bytes>>,
    ) -> TunnelResponse {
        let tls_stream = self
            .connect(proxy_header, DOMAIN)
            .await
            .expect("a TLS connection to the tunnel listener");
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(tls_stream))
                .await
                .expect("an HTTP/1.1 connection");
        tokio::spawn(connection);
        let response = sender
            .send_request(request)
            .await
            .expect("the tunnel listener answers");
        let (parts, body) = response.into_parts();
        TunnelResponse {
            status: parts.status,
            headers: parts.headers,
            body: body.collect().await.expect("the whole body").to_bytes(),
        }
    }
}

/// A request to `path` (with its query) on the server, as a visitor's
/// browser or app sends it: `Host` names the domain.
fn request(method: Method, path: &str) -> http::request::Builder {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, DOMAIN)
}

/// `GET path` with no body.
fn get(path: &str) -> Request<Full<Bytes>> {
    request(Method::GET, path)
        .body(Full::default())
        .expect("a request")
}

/// `builder`'s request with `body` as JSON.
fn with_json(builder: http::request::Builder, body: &Value) -> Request<Full<Bytes>> {
    builder
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("a request")
}

/// The path and query of `url`, an absolute URL on the server's origin.
fn path_of(url: &str) -> String {
    let url = Url::parse(url).expect("an absolute URL");
    assert_eq!(
        url.origin().ascii_serialization(),
        SERVER_ORIGIN,
        "{url} is on the server's origin"
    );
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    }
}

/// A response read off the tunnel listener.
struct TunnelResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl TunnelResponse {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("a JSON body ({error}): {}", self.text()))
    }

    fn text(&self) -> String {
        String::from_utf8(self.body.to_vec()).expect("a UTF-8 body")
    }

    /// The response's `Location`.
    fn location(&self) -> String {
        self.header(header::LOCATION)
            .expect("a Location")
            .to_owned()
    }

    fn header(&self, name: header::HeaderName) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The `name=value` pairs the response's `Set-Cookie` headers set.
    fn cookies_set(&self) -> Vec<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|cookie| cookie.split(';').next())
            .map(str::to_owned)
            .collect()
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

/// A PROXY protocol v2 header for the visitor at `source`, as the relay
/// writes it.
fn proxy_header(source: &str) -> Vec<u8> {
    wildflowerhealthio_rathole_settings::proxy_header::proxy_header(
        source.parse().expect("source address"),
        "198.51.100.1:443".parse().expect("relay address"),
    )
    .expect("PROXY header")
}

/// The visitor address and status of the request logged next.
async fn next_report(logged_requests: &mut LoggedRequests) -> (Option<String>, u16) {
    let forwarded_request = logged_requests.next().await;
    (forwarded_request.client_address, forwarded_request.status)
}

/// `/health`'s status and its decoded health report, through the tunnel.
async fn health_report(tunnel: &TunnelClient) -> (StatusCode, HealthReport) {
    let response = tunnel.send(get("/health")).await;
    assert_eq!(
        response.header(header::CONTENT_TYPE),
        Some("application/health+json")
    );
    let report = serde_json::from_slice(&response.body).expect("a health report");
    (response.status, report)
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_returns_on_shutdown_and_the_server_sets_up_again_over_its_folder() {
    let data_root = tempfile::tempdir().expect("temp data root");
    // A server's folder as the host lays it out, `<data root>/servers/<domain>/`,
    // which doesn't exist until the server creates it.
    let server_dir = data_root.path().join("servers").join(DOMAIN);

    let (server_health_tx, server_health_rx) = watch::channel(None);
    let (tunnel_state_tx, mut tunnel_state_rx) = watch::channel(None);
    let observers = ServerObservers {
        server_health_tx,
        tunnel_state_tx,
        certificate_tx: watch::channel(None).0,
        pending_consent_tx: watch::channel(None).0,
    };

    let first_shutdown = CancellationToken::new();
    let (tunnel, _handles, first) =
        start_serving(&server_dir, observers.clone(), first_shutdown.clone()).await;
    let mut logged_requests = LoggedRequests::of(&server_dir);
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
    // `/health`, as the reachability monitor asks it through the relay, is
    // the two checks: the server passing, and its tunnel, which is
    // reconnecting, warning; a warning is still `200`.
    let (status, report) = health_report(&tunnel).await;
    assert_eq!(status, StatusCode::OK);
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
    // The `/health` above is logged, and so is a FHIR read, with no caller
    // (`/metadata` is unauthenticated).
    assert_eq!(logged_requests.next().await.reduced_path, "/health");
    let metadata = tunnel
        .send_from(Some(&proxy_header("192.0.2.1:4711")), get("/metadata"))
        .await;
    assert_eq!(metadata.status, StatusCode::OK);
    let forwarded_request = logged_requests.next().await;
    assert_eq!(
        (
            forwarded_request.reduced_path.as_str(),
            forwarded_request.status,
            forwarded_request.client_address.as_deref(),
            forwarded_request.caller,
        ),
        ("/metadata", 200, Some("192.0.2.1"), None)
    );
    // The host sees the server's health through its public origin only once
    // the tunnel is connected, which it never is here: well past the first
    // probe's delay, no verdict is published.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(*server_health_rx.borrow(), None);

    shut_down(&first_shutdown, first).await;

    let second_shutdown = CancellationToken::new();
    let (tunnel, _handles, second) =
        start_serving(&server_dir, observers, second_shutdown.clone()).await;
    assert_eq!(tunnel.send(get("/health")).await.status, StatusCode::OK);
    shut_down(&second_shutdown, second).await;
}

/// The TCP ports this process listens on, read from the kernel's socket
/// tables: the sockets this process's descriptors hold, in the `LISTEN` state.
#[cfg(target_os = "linux")]
fn listening_tcp_ports_of_this_process() -> Vec<u16> {
    let socket_inodes: Vec<String> = std::fs::read_dir("/proc/self/fd")
        .expect("this process's descriptors")
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .filter_map(|target| {
            target
                .to_str()?
                .strip_prefix("socket:[")?
                .strip_suffix(']')
                .map(str::to_owned)
        })
        .collect();
    let mut ports = Vec::new();
    for table in ["/proc/self/net/tcp", "/proc/self/net/tcp6"] {
        let Ok(rows) = std::fs::read_to_string(table) else {
            continue;
        };
        // `sl local_address rem_address st … inode …`, a header row first.
        for row in rows.lines().skip(1) {
            let fields: Vec<&str> = row.split_whitespace().collect();
            let (Some(local_address), Some(state), Some(inode)) =
                (fields.get(1), fields.get(3), fields.get(9))
            else {
                continue;
            };
            if *state != "0A" || !socket_inodes.iter().any(|socket| socket == inode) {
                continue;
            }
            let port = local_address
                .rsplit_once(':')
                .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
                .expect("a hex port");
            ports.push(port);
        }
    }
    ports
}

/// The server binds no port, so nothing on this machine reaches it but
/// through its tunnel, and two servers run side by side, each answering
/// through its own tunnel listener. (Nothing else in this test binary listens.)
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn the_server_listens_only_on_its_tunnel_listener() {
    let shutdown = CancellationToken::new();
    let mut running = Vec::new();
    for _ in 0..2 {
        let server_dir = tempfile::tempdir().expect("temp server folder");
        let (tunnel, _handles, serving) =
            start_serving(server_dir.path(), observers(), shutdown.clone()).await;
        running.push((server_dir, tunnel, serving));
    }

    for (_, tunnel, _) in &running {
        assert_eq!(tunnel.send(get("/health")).await.status, StatusCode::OK);
    }
    assert_eq!(
        listening_tcp_ports_of_this_process(),
        Vec::<u16>::new(),
        "a serving server listens on no TCP port"
    );

    for (_server_dir, _tunnel, serving) in running {
        shut_down(&shutdown, serving).await;
    }
}

/// A client token issued by and for `server_origin`, granting `scopes`, signed
/// with the key the authorization server keeps in the server's database under `server_dir`.
fn client_token(server_dir: &Path, server_origin: &str, scopes: &[String]) -> String {
    // The server's shared database (`WILDFLOWER_DB` in `set_up`); a wrong name
    // opens an empty one, with no signing key to find.
    let pool = wildflowerhealthio_persistence::open_pool(&server_dir.join("wildflower.sqlite"))
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
            sid: None,
        },
    )
    .expect("mint a client token")
}

/// `GET path` with `bearer_token`.
fn get_with_bearer(path: &str, bearer_token: &str) -> Request<Full<Bytes>> {
    request(Method::GET, path)
        .header(header::AUTHORIZATION, format!("Bearer {bearer_token}"))
        .body(Full::default())
        .expect("a request")
}

/// Whether the request log, read with `bearer_token`, holds a
/// `GET /metadata` from `192.0.2.1`.
async fn request_log_holds_metadata_from_the_visitor(
    tunnel: &TunnelClient,
    bearer_token: &str,
) -> bool {
    let response = tunnel
        .send(get_with_bearer("/requests", bearer_token))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    response.json()["requests"]
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
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let shutdown = CancellationToken::new();
    let (tunnel, _handles, serving) =
        start_serving(server_dir.path(), observers(), shutdown.clone()).await;
    let request_log_scopes = wildflowerhealthio_request_log::grantable_request_log_scopes()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let request_log_reader = client_token(server_dir.path(), SERVER_ORIGIN, &request_log_scopes);
    let other_servers_reader =
        client_token(server_dir.path(), OTHER_SERVER_ORIGIN, &request_log_scopes);
    let apps_reader = client_token(
        server_dir.path(),
        SERVER_ORIGIN,
        &["wildflower/Apps.r".to_owned()],
    );

    let metadata = tunnel
        .send_from(Some(&proxy_header("192.0.2.1:4711")), get("/metadata"))
        .await;
    assert_eq!(metadata.status, StatusCode::OK);

    // The writer records off the request path, so the row lands a moment after
    // the response; read until it does.
    tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
        while !request_log_holds_metadata_from_the_visitor(&tunnel, &request_log_reader).await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the forwarded request is logged in time");
    assert_eq!(
        tunnel
            .send(get_with_bearer("/requests", &apps_reader))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        tunnel.send(get("/requests")).await.status,
        StatusCode::UNAUTHORIZED
    );
    // A token another server minted is refused, though it carries the scope and
    // this server's own key signed it.
    assert_eq!(
        tunnel
            .send(get_with_bearer("/requests", &other_servers_reader))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );

    shut_down(&shutdown, serving).await;
}

/// A request with no bearer is refused at every gated surface: nothing
/// presents a credential on a caller's behalf.
#[tokio::test(flavor = "multi_thread")]
async fn a_request_without_a_bearer_is_unauthorized() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let shutdown = CancellationToken::new();
    let (tunnel, _handles, serving) =
        start_serving(server_dir.path(), observers(), shutdown.clone()).await;

    // The authorization server's admin surface, the request log, the database
    // catalogue, the apps and the FHIR API.
    for path in [
        "/authorization/clients",
        "/requests",
        "/databases",
        "/apps",
        "/Patient",
    ] {
        assert_eq!(
            tunnel.send(get(path)).await.status,
            StatusCode::UNAUTHORIZED,
            "GET {path}"
        );
    }

    shut_down(&shutdown, serving).await;
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

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_listener_serves_remote_requests_as_the_public_origin() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let shutdown = CancellationToken::new();
    let (tunnel, _handles, serving) =
        start_serving(server_dir.path(), observers(), shutdown.clone()).await;
    // `start_serving`'s TLS handshakes sent no request: each one logged below
    // is the only one since the last.
    let mut logged_requests = LoggedRequests::of(server_dir.path());

    // The owner-gated `/apps` refuses a request with no bearer. It is reported
    // with no visitor address (no PROXY header).
    let (status, _) = tunnel_exchange(&tunnel, None, &tunnel_get("/apps", DOMAIN, ""))
        .await
        .expect("the tunnel listener answers");
    assert_eq!(status, 401);
    assert_eq!(
        next_report(&mut logged_requests).await,
        (None, 401),
        "a tunnel request is forwarded"
    );

    // Discovery renders the public origin, even when the visitor spells the
    // domain another way and sends a `Forwarded` of its own naming another
    // host and scheme.
    let (status, smart_configuration) = tunnel_exchange(
        &tunnel,
        None,
        &tunnel_get(
            "/.well-known/smart-configuration",
            &format!("{}:443", DOMAIN.to_uppercase()),
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
        next_report(&mut logged_requests).await,
        (None, 200),
        "the visitor's `Forwarded` names no visitor"
    );

    // A TLS handshake naming another host fails, before any request.
    assert!(
        tunnel.connect(None, "other.example.com").await.is_err(),
        "no certificate for another host"
    );

    // A request naming a host other than the domain, over TLS for the
    // domain, is misdirected, and not logged: the next one logged is the only
    // one since the last.
    let (status, _) = tunnel_exchange(
        &tunnel,
        None,
        &tunnel_get("/metadata", "other.example.com", ""),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 421);
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

    // A token for this server is accepted through the tunnel listener, and
    // one another server minted is refused.
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
            next_report(&mut logged_requests).await,
            (None, expected_status)
        );
    }

    // A PROXY header names the visitor to the request log, and is stripped
    // before HTTP.
    for (source, client_address) in [
        ("192.0.2.1:4711", "192.0.2.1"),
        ("[2001:db8::1]:4711", "2001:db8::1"),
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
            next_report(&mut logged_requests).await,
            (Some(client_address.to_owned()), 200)
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
    let (status, _) = tunnel_exchange(&tunnel, None, &tunnel_get("/metadata", DOMAIN, ""))
        .await
        .expect("the tunnel listener still answers");
    assert_eq!(status, 200);
    assert_eq!(
        next_report(&mut logged_requests).await,
        (None, 200),
        "the malformed PROXY header's request was not logged"
    );

    shut_down(&shutdown, serving).await;
}

/// `GET /oauth/authorize` for the seeded Plots client with `launch`,
/// as the app's browser would reach it; the `Location` it redirects to.
async fn authorize_plots_launch(tunnel: &TunnelClient, launch: &str, aud: &str) -> String {
    let mut authorize_url = Url::parse(SERVER_ORIGIN)
        .and_then(|origin| origin.join("oauth/authorize"))
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
        .append_pair("redirect_uri", "https://plots.wildflowerhealth.io/")
        .append_pair("state", "xyz")
        .append_pair("launch", launch)
        .append_pair("aud", aud);
    let response = tunnel.send(get(&path_of(authorize_url.as_str()))).await;
    assert_eq!(response.status, StatusCode::FOUND);
    response.location()
}

/// The composition root's launch wiring: `POST /apps/{id}` for a SMART app
/// answers its launch URL with the FHIR base as `iss` and a `launch` the authorization server
/// minted for the app's client, and that `launch` parks one authorization
/// request at `/oauth/authorize`, then is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_smart_launch_is_minted_for_its_client_and_consumed_once() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let shutdown = CancellationToken::new();
    let (tunnel, _handles, serving) =
        start_serving(server_dir.path(), observers(), shutdown.clone()).await;
    let launcher = client_token(
        server_dir.path(),
        SERVER_ORIGIN,
        &[
            "system/*.cruds".to_owned(),
            "wildflower/*.cruds".to_owned(),
            "wildflower/launch".to_owned(),
        ],
    );

    let launched = tunnel
        .send(
            request(Method::POST, "/apps/plots")
                .header(header::AUTHORIZATION, format!("Bearer {launcher}"))
                .body(Full::default())
                .expect("a request"),
        )
        .await;
    assert_eq!(launched.status, StatusCode::OK);
    let launch_url = Url::parse(launched.json()["url"].as_str().expect("a launch URL"))
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

    let parked = authorize_plots_launch(&tunnel, &launch, &iss).await;
    assert!(
        parked.ends_with("/wait"),
        "the launch parks a request for the Owner, got {parked}"
    );
    assert_eq!(
        authorize_plots_launch(&tunnel, &launch, &iss).await,
        "https://plots.wildflowerhealth.io/?error=invalid_request&state=xyz",
        "the launch works once"
    );

    shut_down(&shutdown, serving).await;
}

/// Every URL the SMART discovery document advertises is on the server's
/// origin and is a route the server answers: requested without a token, none
/// is a `404`. The authorization API's base names no resource of its own, so
/// it is walked through its `session` route. The one URL off that origin is
/// the `management_endpoint`, the hosted Wildflower Authorization app pointed
/// at the `issuer`.
#[tokio::test(flavor = "multi_thread")]
async fn every_endpoint_smart_discovery_advertises_is_routed() {
    let server = UiServer::start().await;
    let discovery = server
        .tunnel
        .send(get("/.well-known/smart-configuration"))
        .await
        .json();
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
        let route = if field == "wildflower_authorization_api" {
            url.join("session").expect("the API's session route")
        } else {
            url
        };
        // `path_of` holds the URL to the server's origin.
        let status = server
            .tunnel
            .send(get(&path_of(route.as_str())))
            .await
            .status;
        assert_ne!(status, StatusCode::NOT_FOUND, "{field} ({route}) is routed");
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

/// A composed server serving over a temporary folder, for a browser to use
/// its own pages.
struct UiServer {
    server_dir: tempfile::TempDir,
    tunnel: TunnelClient,
    handles: ServerHandles,
    shutdown: CancellationToken,
    serving: JoinHandle<anyhow::Result<()>>,
}

impl UiServer {
    /// Set a server up over a fresh folder and serve it.
    async fn start() -> Self {
        let server_dir = tempfile::tempdir().expect("temp server folder");
        let shutdown = CancellationToken::new();
        let (tunnel, handles, serving) =
            start_serving(server_dir.path(), observers(), shutdown.clone()).await;
        Self {
            server_dir,
            tunnel,
            handles,
            shutdown,
            serving,
        }
    }

    /// Sign a browser in as the Owner with a code the host mints, as the
    /// host's same-device sign-in does, and return the session cookie
    /// (`name=value`) `/oauth/sign-in` sets.
    async fn sign_in_as_the_owner(&self) -> String {
        let mut sign_in_url = Url::parse(SERVER_ORIGIN)
            .and_then(|origin| origin.join("oauth/sign-in"))
            .expect("sign-in URL");
        sign_in_url
            .query_pairs_mut()
            .append_pair("code", &self.handles.same_device_sign_in_code_minter.mint())
            .append_pair("next", "/ui");
        let signed_in = self.tunnel.send(get(&path_of(sign_in_url.as_str()))).await;
        assert_eq!(signed_in.status, StatusCode::SEE_OTHER);
        assert_eq!(signed_in.location(), "/ui");
        signed_in
            .cookies_set()
            .into_iter()
            .find(|cookie| {
                cookie.starts_with(&format!(
                    "{}=",
                    wildflowerhealthio_authorization_server::OWNER_BROWSER_SESSION_COOKIE
                ))
            })
            .expect("the Owner browser session cookie")
    }

    /// A request the server's own page sends to `path`: same-origin,
    /// carrying `session_cookie` when there is one.
    fn page_request(
        method: Method,
        path: &str,
        session_cookie: Option<&str>,
    ) -> http::request::Builder {
        let request = request(method, path)
            .header("sec-fetch-site", "same-origin")
            .header(header::ORIGIN, SERVER_ORIGIN);
        match session_cookie {
            Some(session_cookie) => request.header(header::COOKIE, session_cookie),
            None => request,
        }
    }

    /// [`Self::page_request`] with no body, sent.
    async fn page_get(&self, path: &str, session_cookie: Option<&str>) -> TunnelResponse {
        self.tunnel
            .send(
                Self::page_request(Method::GET, path, session_cookie)
                    .body(Full::default())
                    .expect("a request"),
            )
            .await
    }

    /// Cancel the server and wait for `serve` to return, handing back its
    /// folder.
    async fn shut_down(self) -> tempfile::TempDir {
        shut_down(&self.shutdown, self.serving).await;
        self.server_dir
    }
}

/// The FHIR web UI's sign-in through the composed server, as far as a test
/// reaches: its assets are served without a session, the UI sends the
/// browser to the authorization server's authorize endpoint on the server's
/// origin as its seeded client, the Owner approves, and the browser is sent
/// back to the UI's callback there. A FHIR read without a session is refused
/// at the gate.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_sends_its_sign_in_through_the_authorization_server() {
    let server = UiServer::start().await;

    // The UI's assets are served before sign-in, past the gate; a `/ui` path
    // the UI doesn't serve falls through to the gate.
    assert_eq!(
        server.tunnel.send(get("/ui/assets/app.css")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        server.tunnel.send(get("/ui/no-such-page")).await.status,
        StatusCode::UNAUTHORIZED
    );

    let login = server.tunnel.send(get("/ui/login")).await;
    let authorize_url = login.location();
    assert!(
        authorize_url.starts_with(&format!("{SERVER_ORIGIN}/oauth/authorize?")),
        "sent to the authorization server's authorize endpoint, got {authorize_url}"
    );

    let parked = server.tunnel.send(get(&path_of(&authorize_url))).await;
    let wait_page = parked.location();
    let request_id = wait_page
        .strip_prefix("authorize/")
        .and_then(|rest| rest.strip_suffix("/wait"))
        .unwrap_or_else(|| panic!("parked for the Owner, got {wait_page}"));
    let owner_scopes: Vec<String> =
        wildflowerhealthio_authorization_server::WILDFLOWER_WIDEST_SCOPES
            .iter()
            .map(ToString::to_string)
            .collect();
    let owner_token = client_token(server.server_dir.path(), SERVER_ORIGIN, &owner_scopes);
    let approved = server
        .tunnel
        .send(with_json(
            request(
                Method::POST,
                &format!("/authorization/oauth-consents/{request_id}/approve"),
            )
            .header(header::AUTHORIZATION, format!("Bearer {owner_token}")),
            &serde_json::json!({
                "approvedScopes": ["user/*.cruds"],
                "patient": null,
                "acknowledgedRegistration": true,
            }),
        ))
        .await
        .json();
    let callback_url = approved["redirect"]
        .as_str()
        .unwrap_or_else(|| panic!("approved with a redirect, got {approved}"));
    assert!(callback_url.starts_with(&format!("{SERVER_ORIGIN}/ui/callback?")));
    // Gap: the callback redeems the code at `https://<domain>/oauth/token`,
    // out through the relay, which no test reaches, so no UI session is made.

    assert_eq!(
        server.page_get("/Patient", None).await.status,
        StatusCode::UNAUTHORIZED
    );

    server.shut_down().await;
}

/// The same-device sign-in of an Owner browser, end to end through the
/// composed server: a code the host mints signs a browser in and sends it on,
/// and its `__Host-owner_browser_session` cookie alone then reads
/// `GET /authorization/session` as the Owner from the server's own pages, and
/// FHIR, which HFS checks against the authorization server's keys. A write
/// carrying the cookie from another server's page is refused; one from the
/// server's own page goes through on it, here revoking the session's own
/// `jti`, after which the cookie is skipped, so the request gets `401`, and
/// the response clears it.
#[tokio::test(flavor = "multi_thread")]
async fn the_owner_signs_in_with_a_code_and_is_served_on_the_cookie() {
    let server = UiServer::start().await;
    let owner_cookie = server.sign_in_as_the_owner().await;
    let session = || server.page_get("/authorization/session", Some(&owner_cookie));

    let signed_in_session = session().await;
    assert_eq!(signed_in_session.status, StatusCode::OK);
    assert_eq!(
        signed_in_session.json()["scopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::owner_scopes())
    );
    let patients = server.page_get("/Patient", Some(&owner_cookie)).await;
    assert_eq!(patients.status, StatusCode::OK);
    assert_eq!(patients.json()["resourceType"], "Bundle");
    // Gap: which session wins beside the FHIR web UI's `hfs_session` needs a
    // UI session, which no test signs in (its code redemption goes out
    // through the relay); `session_cookie_bearer`'s own tests cover it.

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

    let from_another_server = server
        .tunnel
        .send(with_json(
            request(Method::POST, "/authorization/revocations")
                .header("sec-fetch-site", "same-site")
                .header(header::ORIGIN, OTHER_SERVER_ORIGIN)
                .header(header::COOKIE, &owner_cookie),
            &revoke_the_session,
        ))
        .await;
    assert_eq!(from_another_server.status, StatusCode::FORBIDDEN);
    assert_eq!(session().await.status, StatusCode::OK);

    let from_its_own_page = server
        .tunnel
        .send(with_json(
            UiServer::page_request(
                Method::POST,
                "/authorization/revocations",
                Some(&owner_cookie),
            ),
            &revoke_the_session,
        ))
        .await;
    assert_eq!(from_its_own_page.status, StatusCode::NO_CONTENT);
    let signed_out = session().await;
    assert_eq!(signed_out.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        signed_out.cookies_set(),
        [format!(
            "{}=",
            wildflowerhealthio_authorization_server::OWNER_BROWSER_SESSION_COOKIE
        )],
        "the ended session's cookie is cleared"
    );

    server.shut_down().await;
}

/// A page on another server behind the same relay is same-site to this one,
/// so its form posts carry this server's session cookies. Neither a FHIR write
/// nor a write through the UI's own routes, which sit outside the gate, rides
/// the Owner browser session: both are refused before they reach HFS. (The
/// FHIR web UI's own session can't be signed in here, its code redemption
/// going out through the relay; `session_cookie_bearer`'s own tests cover it.)
#[tokio::test(flavor = "multi_thread")]
async fn another_server_s_page_cannot_write_on_a_session_cookie() {
    let server = UiServer::start().await;
    let owner_cookie = server.sign_in_as_the_owner().await;
    let user_settings = || async {
        server
            .page_get("/_user/settings", Some(&owner_cookie))
            .await
            .text()
    };
    let settings_before = user_settings().await;

    // The body each would send without a preflight: JSON as `text/plain` to
    // the FHIR API, the UI's own form encoding to its route, which writes the
    // user's settings.
    for (path, content_type, body) in [
        ("/Patient", "text/plain", r#"{"resourceType":"Patient"}"#),
        (
            "/ui/version",
            "application/x-www-form-urlencoded",
            "version=R4",
        ),
    ] {
        let form_post = server
            .tunnel
            .send(
                request(Method::POST, path)
                    .header("sec-fetch-site", "same-site")
                    .header(header::ORIGIN, OTHER_SERVER_ORIGIN)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::COOKIE, &owner_cookie)
                    .body(Full::new(Bytes::from_static(body.as_bytes())))
                    .expect("a request"),
            )
            .await;
        assert_eq!(form_post.status, StatusCode::FORBIDDEN, "POST {path}");
    }

    let patients = server
        .page_get("/Patient", Some(&owner_cookie))
        .await
        .json();
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

/// The FHIR web UI's per-user settings, on the Owner browser session: a
/// document put is the one got back, the gate refuses the same read without
/// the cookie, and the document is stored in the health data's own sqlite
/// file.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_keeps_its_settings_in_the_health_data_file() {
    let server = UiServer::start().await;
    let owner_cookie = server.sign_in_as_the_owner().await;
    let settings = serde_json::json!({ "theme": "dark" });

    let put = server
        .tunnel
        .send(with_json(
            UiServer::page_request(Method::PUT, "/_user/settings", Some(&owner_cookie)),
            &settings,
        ))
        .await;
    assert_eq!(put.status, StatusCode::OK);
    let got = server
        .page_get("/_user/settings", Some(&owner_cookie))
        .await;
    assert_eq!(got.status, StatusCode::OK);
    assert_eq!(got.json(), settings);
    assert_eq!(
        server.page_get("/_user/settings", None).await.status,
        StatusCode::UNAUTHORIZED
    );

    let server_dir = server.shut_down().await;
    let health_data = rusqlite::Connection::open(server_dir.path().join("health-data.sqlite"))
        .expect("the health data's sqlite file opens");
    let stored: Vec<u8> = health_data
        .query_row("SELECT data FROM user_settings", [], |row| row.get(0))
        .expect("one settings document in the health data's file");
    assert_eq!(
        serde_json::from_slice::<Value>(&stored).expect("stored as JSON"),
        settings
    );
}

/// The FHIR web UI's bulk export pages are its own, behind its sign-in: an
/// Owner browser session alone, which serves FHIR, is sent to the UI's login.
#[tokio::test(flavor = "multi_thread")]
async fn the_fhir_ui_s_bulk_export_pages_ask_for_its_sign_in() {
    let server = UiServer::start().await;
    let owner_cookie = server.sign_in_as_the_owner().await;

    for path in ["/ui/bulk-export", "/ui/bulk-export/new"] {
        let page = server.page_get(path, Some(&owner_cookie)).await;
        assert_eq!(page.status, StatusCode::SEE_OTHER, "GET {path}");
        assert!(
            page.location().contains("/ui/login"),
            "GET {path} is sent to the UI's login, got {}",
            page.location()
        );
    }
    // Gap: that the pages offer the list of jobs and the form for a new one
    // needs a UI session, whose code redemption goes out through the relay
    // (`https://<domain>/oauth/token`), which no test reaches.

    server.shut_down().await;
}

/// A bulk `$export` on the Owner browser session, end to end: the server
/// accepts it, its worker runs it to a manifest, the manifest's file downloads
/// on the same session with the Patient the session wrote, and the file is
/// staged in the server's `fhir-exports` folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_bulk_export_runs_and_its_files_download() {
    let server = UiServer::start().await;
    let owner_cookie = server.sign_in_as_the_owner().await;

    let created = server
        .tunnel
        .send(
            UiServer::page_request(Method::POST, "/Patient", Some(&owner_cookie))
                .header(header::CONTENT_TYPE, "application/fhir+json")
                .body(Full::new(Bytes::from(
                    serde_json::json!({
                        "resourceType": "Patient",
                        "name": [{ "family": "Exported" }],
                    })
                    .to_string(),
                )))
                .expect("a request"),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let patient_id = created.json()["id"].as_str().expect("an id").to_owned();

    let kickoff = server
        .tunnel
        .send(
            UiServer::page_request(Method::GET, "/$export", Some(&owner_cookie))
                .header(header::ACCEPT, "application/fhir+json")
                .header("prefer", "respond-async")
                .body(Full::default())
                .expect("a request"),
        )
        .await;
    assert_eq!(kickoff.status, StatusCode::ACCEPTED, "{}", kickoff.text());
    let status_url = kickoff
        .header(header::CONTENT_LOCATION)
        .expect("a Content-Location to poll")
        .to_owned();

    let manifest: Value = tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
        loop {
            let status = server
                .page_get(&path_of(&status_url), Some(&owner_cookie))
                .await;
            match status.status {
                StatusCode::ACCEPTED => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                StatusCode::OK => break status.json(),
                other => panic!("the export fails: {other} {}", status.text()),
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
        .page_get(&path_of(&patient_file_url), Some(&owner_cookie))
        .await;
    assert_eq!(download.status, StatusCode::OK);
    let exported_ids: Vec<String> = download
        .text()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).expect("a JSON resource")["id"]
                .as_str()
                .expect("an id")
                .to_owned()
        })
        .collect();
    assert_eq!(exported_ids, vec![patient_id]);

    let server_dir = server.shut_down().await;
    let staged_files = walk_files(&server_dir.path().join("fhir-exports"));
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

/// How many authorization requests one visitor may start at once: the
/// server's `PER_CLIENT` burst (`adapters/authorization_start_limit.rs`).
const AUTHORIZATION_STARTS_PER_VISITOR_BURST: usize = 10;

/// The tunnel router's limit on starting authorization requests: one visitor
/// over its burst of `GET /oauth/authorize` is answered `429`, which the
/// request log records with the visitor's address, while another visitor
/// still gets through.
#[tokio::test(flavor = "multi_thread")]
async fn a_visitor_over_its_burst_of_authorization_starts_is_refused_and_reported() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let shutdown = CancellationToken::new();
    let (tunnel, _handles, serving) =
        start_serving(server_dir.path(), observers(), shutdown.clone()).await;
    let mut logged_requests = LoggedRequests::of(server_dir.path());
    let visitor = proxy_header("192.0.2.7:4711");

    // Malformed, so each admitted one is a `400`: the limit counts it anyway.
    for _ in 0..AUTHORIZATION_STARTS_PER_VISITOR_BURST {
        let response = tunnel
            .send_from(Some(&visitor), get("/oauth/authorize"))
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            next_report(&mut logged_requests).await,
            (Some("192.0.2.7".to_owned()), 400)
        );
    }

    let refused = tunnel
        .send_from(Some(&visitor), get("/oauth/authorize"))
        .await;
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.header(header::CACHE_CONTROL), Some("no-store"));
    assert_eq!(
        refused.text(),
        "too many authorization requests; try again later"
    );
    // The log keeps a path's first segment only.
    let reported = logged_requests.next().await;
    assert_eq!(
        (
            reported.reduced_path.as_str(),
            reported.status,
            reported.client_address.as_deref(),
        ),
        ("/oauth", 429, Some("192.0.2.7"))
    );

    let other_visitor = tunnel
        .send_from(
            Some(&proxy_header("198.51.100.9:4711")),
            get("/oauth/authorize"),
        )
        .await;
    assert_eq!(other_visitor.status, StatusCode::BAD_REQUEST);

    shut_down(&shutdown, serving).await;
}
