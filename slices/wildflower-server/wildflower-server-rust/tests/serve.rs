//! The server's lifecycle: `set_up` creates the server's folder and opens its
//! databases there, and once it has bound the port, cancelling `serve`'s
//! shutdown token makes it return `Ok`. The loopback port is then free for a
//! second server over the same folder and the same host channels, which comes
//! up and answers `/health` with its three passing checks. While serving, the
//! host's observers see the server's health through its public origin and each
//! forwarded request, and the request log records
//! each forwarded request and serves it back on `/requests` to a token holding
//! the request log's read scope — a token naming the server's origin as `iss`
//! and `aud`, accepted from a direct loopback caller, from a front run on this
//! machine and through the tunnel listener, while one another server minted is
//! refused.
//!
//! The tunnel listener serves the same API as a remote origin: its requests
//! are held to the server's public host, never get the owner token, are served
//! as the public origin whatever `Forwarded` they carry, and name the visitor
//! from a PROXY protocol v2 header.
//!
//! A SMART app's launch carries a `launch` the apps slice mints through
//! gatekeeper, which the app's `/oauth/authorize` consumes once.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gatekeeper_rust::domain::token::{mint_access_token, NewJwtArgs};
use gatekeeper_rust::{
    GatekeeperStore, NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
};
use serde_json::Value;
use shared_structures_rust::health_check::{ComponentType, HealthReport, HealthStatus};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tunnel_rust::TunnelStream;
use url::Url;
use wildflower_server_rust::{
    set_up, HostPorts, ServerHealth, ServerObservers, WildflowerServerConfig,
};

/// The `Forwarded` header a front run on this machine stamps on a request it
/// relayed to the loopback listener, from client `192.0.2.1` to
/// `demo.example.com`.
const FORWARDED: &str = "for=192.0.2.1;host=demo.example.com;proto=https";

/// The server's domain: the host every tunnel request must name. No relay
/// serves it, so the reachability monitor never reaches the server.
const PUBLIC_HOST: &str = "test.relay.invalid";

/// The server's origin, from [`PUBLIC_HOST`]: the `iss` and `aud` of every
/// token the server accepts, whichever origin a request was served on.
const SERVER_ORIGIN: &str = "https://test.relay.invalid";

/// Another server's origin.
const OTHER_SERVER_ORIGIN: &str = "https://other.relay.invalid";

/// How long one server may take to come up or wind down before the test fails
/// rather than hangs. Startup indexes the FHIR SearchParameter bundle, which is
/// the slow part.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(120);

/// An on-device webview handle with no popup: the test never launches an app.
struct NoOnDeviceWebview;

impl OnDeviceWebviewHandle for NoOnDeviceWebview {
    fn open(&self, _app_id: String, _title: String, _url: String) {}
}

/// A loopback port nothing is listening on: bind an ephemeral one and release
/// it, so `serve` can bind it next.
fn free_loopback_port() -> u16 {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    probe.local_addr().expect("ephemeral port address").port()
}

fn server_config(server_dir: PathBuf, loopback_base_url: Url) -> WildflowerServerConfig {
    WildflowerServerConfig {
        runtime: ServerRuntimeConfig {
            loopback_base_url,
            server_dir,
        },
        search_parameter_data_dir: PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../emr/emr-rust/assets"
        )),
        owner_ui_base: OwnerUiBase::parse("https://owner-ui.test/app/").expect("owner UI base"),
        // The owner-defining scopes gatekeeper requires the host owner token to cover.
        host_owner_scopes: gatekeeper_rust::WILDFLOWER_WIDEST_SCOPES
            .iter()
            .map(ToString::to_string)
            .collect(),
        first_party_client_id: gatekeeper_rust::FIRST_PARTY_CLIENT_ID.to_owned(),
        // A relay nothing listens at: the tunnel dials and retries in the
        // background, which the server's lifecycle doesn't wait on, and the
        // public host below never answers.
        relay_settings: tunnel_rust::RelaySettings {
            remote_addr: "127.0.0.1:9".to_owned(),
            token: "test-tunnel-token".to_owned(),
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            service_name: "test".to_owned(),
        },
        public_host: PUBLIC_HOST.to_owned(),
    }
}

/// Set the server up, which binds the loopback port, then spawn `serve`.
async fn start_serving(
    config: WildflowerServerConfig,
    host_ports: HostPorts,
    observers: ServerObservers,
    shutdown: CancellationToken,
) -> JoinHandle<anyhow::Result<()>> {
    let server = set_up(config, host_ports, observers)
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

    // Host-owned channels, shared by both runs as the host's bridge shares them.
    // The receivers stand in for the bridge's.
    let (host_owner_token_tx, _host_owner_token_rx) = watch::channel(None);
    let (active_pending_consent_tx, _active_pending_consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_tx,
        active_pending_consent_tx,
    };
    let (server_health_tx, mut server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, mut forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        forwarded_request_tx,
    };
    let config = server_config(server_dir.clone(), loopback_base_url.clone());

    let first_shutdown = CancellationToken::new();
    let first = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            config.clone(),
            host_ports.clone(),
            observers.clone(),
            first_shutdown.clone(),
        ),
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
    // `/health` is the two checks, all passing on a healthy server.
    let (status, report) = health_report(&loopback_base_url).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(report.status, HealthStatus::Pass);
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
                vec![(ComponentType::Component, HealthStatus::Pass)]
            ),
            ("server", vec![(ComponentType::System, HealthStatus::Pass)]),
        ]
    );
    // The loopback `/health` above is not reported. A forwarded one is logged
    // but not sent to the host; a forwarded FHIR read is sent to both, with no
    // caller (`/fhir-r4/metadata` is unauthenticated).
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
        ("/fhir-r4", 200, Some("192.0.2.1"), None)
    );
    assert!(
        forwarded_request_rx.try_recv().is_err(),
        "only the forwarded request is reported"
    );
    // The host sees the server's health through its public origin, which no
    // relay serves here: unreachable, with why.
    let published = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        server_health_rx.wait_for(Option::is_some),
    )
    .await
    .expect("the server health is published in time")
    .expect("the test holds the server-health sender")
    .clone();
    assert!(
        matches!(&published, Some(ServerHealth::Unreachable { error }) if !error.is_empty()),
        "{published:?}"
    );

    first_shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, first)
        .await
        .expect("the first serve returns in time once cancelled")
        .expect("the first serve task doesn't panic")
        .expect("a cancelled serve returns Ok");

    let second_shutdown = CancellationToken::new();
    let second = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(config, host_ports, observers, second_shutdown.clone()),
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
/// with the key gatekeeper keeps in the server's database under `app_data_dir`.
fn client_token(app_data_dir: &Path, server_origin: &str, scopes: &[String]) -> String {
    // The server's shared database (`WILDFLOWER_DB` in `set_up`); a wrong name
    // opens an empty one, with no signing key to find.
    let pool = persistence_rust::open_pool(&app_data_dir.join("wildflower.sqlite"))
        .expect("open the server's database");
    let signing_key = SqliteGatekeeperStore::new(pool)
        .expect("gatekeeper store")
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

/// The status of a `GET /fhir-r4/metadata` relayed from `192.0.2.1`: an
/// unauthenticated request the forwarded-request layer reports.
async fn forwarded_metadata_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    reqwest::Client::new()
        .get(
            loopback_base_url
                .join("fhir-r4/metadata")
                .expect("metadata URL"),
        )
        .header("forwarded", FORWARDED)
        .send()
        .await
        .expect("a forwarded GET /fhir-r4/metadata reaches the server")
        .status()
}

/// Whether the request log, read with `bearer_token`, holds a
/// `GET /fhir-r4/metadata` relayed from `192.0.2.1`.
async fn request_log_holds_forwarded_metadata(loopback_base_url: &Url, bearer_token: &str) -> bool {
    let response = forwarded_request_log_read(loopback_base_url, Some(bearer_token)).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let page: Value = response.json().await.expect("a JSON request-log page");
    page["requests"]
        .as_array()
        .expect("a requests array")
        .iter()
        .any(|logged| logged["path"] == "/fhir-r4" && logged["address"] == "192.0.2.1")
}

/// The composition root's request-log wiring: the forwarded-request layer feeds
/// the request log's writer, and `/requests` sits behind the gatekeeper bearer
/// gate, which hands the request log's scope check the caller's scopes.
#[tokio::test(flavor = "multi_thread")]
async fn the_request_log_records_forwarded_requests_behind_its_scope() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    // The receivers stand in for the host bridge's, held for the whole run.
    let (host_owner_token_tx, _host_owner_token_rx) = watch::channel(None);
    let (active_pending_consent_tx, _active_pending_consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_tx,
        active_pending_consent_tx,
    };
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        forwarded_request_tx,
    };
    let shutdown = CancellationToken::new();
    let serving = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
            host_ports,
            observers,
            shutdown.clone(),
        ),
    )
    .await
    .expect("the server binds in time");
    let request_log_scopes = request_log_rust::grantable_request_log_scopes()
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

/// Hand the tunnel listener a visitor's connection, as the tunnel does, and
/// send `request` (raw HTTP/1.1, asking the server to close) on it, after
/// `proxy_header` if given. Returns the response's status code and body;
/// `None` when the server closes the connection without answering.
async fn tunnel_exchange(
    tunnel_stream_tx: &mpsc::Sender<TunnelStream>,
    proxy_header: Option<&[u8]>,
    request: &str,
) -> Option<(u16, String)> {
    let response = raw_tunnel_exchange(tunnel_stream_tx, proxy_header, request).await;
    let status = response.split(' ').nth(1)?.parse().ok()?;
    let (_, body) = response.split_once("\r\n\r\n")?;
    Some((status, body.to_owned()))
}

/// [`tunnel_exchange`]'s whole response, unparsed: empty when the server
/// closes the connection without answering.
async fn raw_tunnel_exchange(
    tunnel_stream_tx: &mpsc::Sender<TunnelStream>,
    proxy_header: Option<&[u8]>,
    request: &str,
) -> String {
    let (mut visitor, tunnel_stream) = tokio::io::duplex(64 * 1024);
    tunnel_stream_tx
        .send(Box::new(tunnel_stream))
        .await
        .expect("the tunnel listener takes streams");
    if let Some(proxy_header) = proxy_header {
        visitor.write_all(proxy_header).await.expect("write header");
    }
    // A server that already closed the connection fails the write; the read
    // says so.
    let _ = visitor.write_all(request.as_bytes()).await;
    let mut response = Vec::new();
    let _ = visitor.read_to_end(&mut response).await;
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
    rathole_settings_rust::proxy_header::proxy_header(
        source.parse().expect("source address"),
        "198.51.100.1:443".parse().expect("relay address"),
    )
    .expect("PROXY header")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_listener_serves_remote_requests_as_the_public_origin() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    // The receivers stand in for the host bridge's, held for the whole run.
    let (host_owner_token_tx, _host_owner_token_rx) = watch::channel(None);
    let (active_pending_consent_tx, _active_pending_consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_tx,
        active_pending_consent_tx,
    };
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, mut forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        forwarded_request_tx,
    };
    let server = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        set_up(
            server_config(server_dir.path().to_owned(), loopback_base_url.clone()),
            host_ports,
            observers,
        ),
    )
    .await
    .expect("the server sets up in time")
    .expect("the server sets up and binds");
    let tunnel_stream_tx = server.tunnel_stream_tx();
    let shutdown = CancellationToken::new();
    let serving = tokio::spawn(server.serve(shutdown.clone()));

    // The owner-gated `/apps` answers a loopback caller, who gets the owner
    // token, and nothing is reported.
    let loopback_apps = reqwest::get(loopback_base_url.join("apps").expect("apps URL"))
        .await
        .expect("GET /apps reaches the loopback listener");
    assert_eq!(loopback_apps.status(), reqwest::StatusCode::OK);
    assert!(forwarded_request_rx.try_recv().is_err());

    // The same request through the tunnel, from a loopback-looking connection
    // with no `Forwarded`, gets no owner token. It is reported as served at
    // the public host, with no visitor address (no PROXY header).
    let (status, _) = tunnel_exchange(
        &tunnel_stream_tx,
        None,
        &tunnel_get("/apps", PUBLIC_HOST, ""),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 401);
    assert_eq!(
        next_report(&mut forwarded_request_rx),
        (Some(PUBLIC_HOST.to_owned()), None, 401),
        "a tunnel request is forwarded, for the public host"
    );

    // Discovery renders the public origin, even when the visitor sends a
    // `Forwarded` of its own naming another host and scheme.
    let (status, smart_configuration) = tunnel_exchange(
        &tunnel_stream_tx,
        None,
        &tunnel_get(
            "/fhir-r4/.well-known/smart-configuration",
            PUBLIC_HOST,
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
        format!("https://{PUBLIC_HOST}/oauth/token")
    );
    assert_eq!(
        next_report(&mut forwarded_request_rx),
        (Some(PUBLIC_HOST.to_owned()), None, 200),
        "the visitor's `Forwarded` is replaced"
    );

    // A host other than the public host is misdirected, and not reported.
    let (status, _) = tunnel_exchange(
        &tunnel_stream_tx,
        None,
        &tunnel_get("/fhir-r4/metadata", "other.example.com", ""),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 421);
    assert!(forwarded_request_rx.try_recv().is_err());
    // A remote app can read the `421`: it carries the CORS headers.
    let response = raw_tunnel_exchange(
        &tunnel_stream_tx,
        None,
        &tunnel_get(
            "/fhir-r4/metadata",
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
    let request_log_scopes = request_log_rust::grantable_request_log_scopes()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for (server_origin, expected_status) in [(SERVER_ORIGIN, 200), (OTHER_SERVER_ORIGIN, 401)] {
        let request_log_reader =
            client_token(server_dir.path(), server_origin, &request_log_scopes);
        let (status, _) = tunnel_exchange(
            &tunnel_stream_tx,
            None,
            &tunnel_get(
                "/requests",
                PUBLIC_HOST,
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
            (Some(PUBLIC_HOST.to_owned()), None, expected_status)
        );
    }

    // A PROXY header names the visitor to the request log, and is stripped
    // before HTTP.
    for (source, client_address) in [
        ("192.0.2.1:4711", "192.0.2.1"),
        ("[2001:db8::1]:4711", "[2001:db8::1]"),
    ] {
        let (status, _) = tunnel_exchange(
            &tunnel_stream_tx,
            Some(&proxy_header(source)),
            &tunnel_get("/fhir-r4/metadata", PUBLIC_HOST, ""),
        )
        .await
        .expect("the tunnel listener answers after a PROXY header");
        assert_eq!(status, 200);
        assert_eq!(
            next_report(&mut forwarded_request_rx),
            (
                Some(PUBLIC_HOST.to_owned()),
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
            &tunnel_stream_tx,
            Some(&malformed),
            &tunnel_get("/fhir-r4/metadata", PUBLIC_HOST, "")
        )
        .await,
        None
    );
    assert!(forwarded_request_rx.try_recv().is_err());
    let (status, _) = tunnel_exchange(
        &tunnel_stream_tx,
        None,
        &tunnel_get("/fhir-r4/metadata", PUBLIC_HOST, ""),
    )
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
        .append_pair("client_id", "health-viewer-app")
        .append_pair("scope", "openid system/Observation.rs")
        .append_pair(
            "code_challenge",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )
        .append_pair(
            "redirect_uri",
            "https://wildflowerhealth.io/health-viewer-app/",
        )
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
/// answers its launch URL with the FHIR base as `iss` and a `launch` gatekeeper
/// minted for the app's client, and that `launch` parks one authorization
/// request at `/oauth/authorize`, then is refused.
#[tokio::test(flavor = "multi_thread")]
async fn a_smart_launch_is_minted_for_its_client_and_consumed_once() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    // The receivers stand in for the host bridge's, held for the whole run.
    let (host_owner_token_tx, _host_owner_token_rx) = watch::channel(None);
    let (active_pending_consent_tx, _active_pending_consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_tx,
        active_pending_consent_tx,
    };
    let (server_health_tx, _server_health_rx) = watch::channel(None);
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(8);
    let observers = ServerObservers {
        server_health_tx,
        forwarded_request_tx,
    };
    let shutdown = CancellationToken::new();
    let serving = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        start_serving(
            server_config(app_data_dir.path().to_owned(), loopback_base_url.clone()),
            host_ports,
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
                .join("apps/health-viewer-app")
                .expect("launch URL"),
        )
        .header("forwarded", FORWARDED)
        .bearer_auth(&launcher)
        .send()
        .await
        .expect("POST /apps/health-viewer-app reaches the server");
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
    assert_eq!(iss, format!("{SERVER_ORIGIN}/fhir-r4"));
    assert!(!launch.is_empty());

    let parked = authorize_health_viewer_launch(&loopback_base_url, &launch, &iss).await;
    assert!(
        parked.ends_with("/wait"),
        "the launch parks a request for the Owner, got {parked}"
    );
    assert_eq!(
        authorize_health_viewer_launch(&loopback_base_url, &launch, &iss).await,
        "https://wildflowerhealth.io/health-viewer-app/?error=invalid_request&state=xyz",
        "the launch works once"
    );

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}
