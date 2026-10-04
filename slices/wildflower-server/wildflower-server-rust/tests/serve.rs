//! The server's lifecycle: once `set_up` has bound the port, cancelling
//! `serve`'s shutdown token makes it return `Ok`, and the loopback port is then
//! free for a second server over the same app-data dir and the same host
//! channels, which comes up and answers `/health`. While serving, the host's
//! observers see the tunnel's liveness and each forwarded request.
//!
//! The tunnel listener serves the same API as a remote origin: its requests are
//! held to the tunnel's public host, never get the owner token, are served as
//! the public origin whatever `Forwarded` they carry, and name the visitor from
//! a PROXY protocol v2 header.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gatekeeper_rust::{NoLoopbackConsentPrompt, PendingConsentHead};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflower_server_rust::{set_up, HostPorts, ServerObservers, WildflowerServerConfig};

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

fn server_config(app_data_dir: PathBuf, loopback_base_url: Url) -> WildflowerServerConfig {
    WildflowerServerConfig {
        runtime: ServerRuntimeConfig {
            loopback_base_url,
            app_data_dir: app_data_dir.clone(),
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
        tunnel_seed: tunnel_rust::SettingsSeed::default(),
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

async fn health_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    let health_url = loopback_base_url.join("health").expect("health URL");
    reqwest::get(health_url)
        .await
        .expect("GET /health reaches the server")
        .status()
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_returns_on_shutdown_and_the_port_rebinds() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");

    // Host-owned channels, shared by both runs as the host's bridge shares them.
    // The receivers stand in for the bridge's.
    let (host_owner_token_sender, _owner_tokens) = watch::channel(None);
    let (active_pending_consent_sender, _pending_consents) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_sender,
        active_pending_consent_sender,
    };
    let (tunnel_liveness_sender, mut tunnel_liveness) = watch::channel(None);
    let (forwarded_request_sender, mut forwarded_requests) = mpsc::channel(8);
    let observers = ServerObservers {
        tunnel_liveness_sender,
        forwarded_request_sender,
    };
    let config = server_config(app_data_dir.path().to_owned(), loopback_base_url.clone());

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
    assert_eq!(
        health_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );
    // The loopback `/health` above is not reported; a forwarded one is, with no
    // caller (`/health` is ungated).
    let forwarded_health = reqwest::Client::new()
        .get(loopback_base_url.join("health").expect("health URL"))
        .header(
            "forwarded",
            "for=192.0.2.1;host=demo.example.com;proto=https",
        )
        .send()
        .await
        .expect("a forwarded GET /health reaches the server");
    assert_eq!(forwarded_health.status(), reqwest::StatusCode::OK);
    let forwarded_request = tokio::time::timeout(LIFECYCLE_TIMEOUT, forwarded_requests.recv())
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
        ("/health", 200, Some("192.0.2.1"), None)
    );
    assert!(
        forwarded_requests.try_recv().is_err(),
        "only the forwarded request is reported"
    );
    // The host sees the tunnel's liveness without holding the tunnel slice.
    tokio::time::timeout(LIFECYCLE_TIMEOUT, tunnel_liveness.wait_for(Option::is_some))
        .await
        .expect("the tunnel liveness is published in time")
        .expect("the test holds the liveness sender");

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

/// The public host the tunnel test seeds: the host every tunnel request must
/// name.
const PUBLIC_HOST: &str = "demo.example.com";

/// Send `request` (raw HTTP/1.1, asking the server to close) to `address`,
/// after `proxy_header` if given, and return the response's status code and
/// body. `None` when the server closes the connection without answering.
async fn raw_exchange(
    address: SocketAddr,
    proxy_header: Option<&[u8]>,
    request: &str,
) -> Option<(u16, String)> {
    let mut stream = TcpStream::connect(address).await.expect("connect");
    if let Some(proxy_header) = proxy_header {
        stream.write_all(proxy_header).await.expect("write header");
    }
    // A server that already closed may reset the write; the read says so.
    let _ = stream.write_all(request.as_bytes()).await;
    let mut response = Vec::new();
    // A close with unread bytes may arrive as a reset rather than EOF.
    let _ = stream.read_to_end(&mut response).await;
    let response = String::from_utf8(response).expect("utf-8 response");
    let status = response.split(' ').nth(1)?.parse().ok()?;
    let body = response.split_once("\r\n\r\n").map(|(_, body)| body)?;
    Some((status, body.to_owned()))
}

/// A `GET path` for the public host over a connection the server closes after
/// answering, with `extra_headers` (each ending in CRLF).
fn tunnel_get(path: &str, extra_headers: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: {PUBLIC_HOST}\r\n{extra_headers}Connection: close\r\n\r\n"
    )
}

/// The served host, visitor address and status of the request reported next.
/// The report is sent before the response, so it is already queued once the
/// response has been read.
fn next_report(
    forwarded_requests: &mut mpsc::Receiver<ForwardedRequest>,
) -> (Option<String>, Option<String>, u16) {
    let forwarded_request = forwarded_requests
        .try_recv()
        .expect("the request was reported");
    (
        forwarded_request.served_host,
        forwarded_request.client_address,
        forwarded_request.status,
    )
}

/// A PROXY protocol v2 header for a visitor at `source`.
fn proxy_header(source: &str) -> Vec<u8> {
    use ppp::v2::{Builder, Command, Protocol, Version};
    let source: SocketAddr = source.parse().expect("source address");
    // `ppp` writes no addresses for a pair of mixed families.
    let relay: SocketAddr = match source {
        SocketAddr::V4(_) => "198.51.100.1:443",
        SocketAddr::V6(_) => "[2001:db8::443]:443",
    }
    .parse()
    .expect("relay address");
    Builder::with_addresses(
        Version::Two | Command::Proxy,
        Protocol::Stream,
        (source, relay),
    )
    .build()
    .expect("PROXY header")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_listener_serves_remote_requests_as_the_public_origin() {
    let app_data_dir = tempfile::tempdir().expect("temp app-data dir");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (host_owner_token_sender, _owner_tokens) = watch::channel(None);
    let (active_pending_consent_sender, _pending_consents) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_sender,
        active_pending_consent_sender,
    };
    let (tunnel_liveness_sender, _tunnel_liveness) = watch::channel(None);
    let (forwarded_request_sender, mut forwarded_requests) = mpsc::channel(8);
    let observers = ServerObservers {
        tunnel_liveness_sender,
        forwarded_request_sender,
    };
    let config = WildflowerServerConfig {
        tunnel_seed: tunnel_rust::SettingsSeed {
            public_host: Some(PUBLIC_HOST.to_owned()),
            relay: None,
        },
        ..server_config(app_data_dir.path().to_owned(), loopback_base_url.clone())
    };

    let server = tokio::time::timeout(LIFECYCLE_TIMEOUT, set_up(config, host_ports, observers))
        .await
        .expect("the server sets up in time")
        .expect("the server sets up and binds");
    let tunnel_listener = server
        .tunnel_listener_addr()
        .expect("tunnel listener address");
    assert!(tunnel_listener.ip().is_loopback());
    let shutdown = CancellationToken::new();
    let serving = tokio::spawn(server.serve(shutdown.clone()));

    // The owner-gated `/tunnel` answers a local caller, who gets the owner
    // token, and nothing is reported.
    let local_tunnel_settings = reqwest::get(loopback_base_url.join("tunnel").expect("URL"))
        .await
        .expect("GET /tunnel reaches the local listener");
    assert_eq!(local_tunnel_settings.status(), reqwest::StatusCode::OK);
    assert!(forwarded_requests.try_recv().is_err());

    // The same request on the tunnel listener, from the same loopback peer and
    // with no `Forwarded`, gets no owner token, and is reported as served for
    // the public host with no visitor address (no PROXY header).
    let (status, _) = raw_exchange(tunnel_listener, None, &tunnel_get("/tunnel", ""))
        .await
        .expect("the tunnel listener answers");
    assert_eq!(status, 401);
    assert_eq!(
        next_report(&mut forwarded_requests),
        (Some(PUBLIC_HOST.to_owned()), None, 401),
        "a tunnel request is forwarded, for the public host"
    );

    // Discovery renders the public origin, even when the visitor sends a
    // `Forwarded` of its own naming another host and scheme.
    let (status, smart_configuration) = raw_exchange(
        tunnel_listener,
        None,
        &tunnel_get(
            "/fhir-r4/.well-known/smart-configuration",
            "Forwarded: for=203.0.113.9;host=evil.example.com;proto=http\r\n",
        ),
    )
    .await
    .expect("the tunnel listener answers");
    assert_eq!(status, 200);
    let smart_configuration: serde_json::Value =
        serde_json::from_str(&smart_configuration).expect("a JSON discovery document");
    assert_eq!(
        smart_configuration["token_endpoint"],
        format!("https://{PUBLIC_HOST}/oauth/token")
    );
    assert_eq!(
        next_report(&mut forwarded_requests),
        (Some(PUBLIC_HOST.to_owned()), None, 200),
        "the visitor's `Forwarded` is replaced"
    );

    // A host other than the public host is misdirected, and not reported.
    let misdirected =
        "GET /health HTTP/1.1\r\nHost: other.example.com\r\nConnection: close\r\n\r\n";
    let (status, _) = raw_exchange(tunnel_listener, None, misdirected)
        .await
        .expect("the tunnel listener answers");
    assert_eq!(status, 421);
    assert!(forwarded_requests.try_recv().is_err());

    // A PROXY header names the visitor, and is stripped before HTTP.
    for (source, client_address) in [
        ("192.0.2.1:4711", "192.0.2.1"),
        ("[2001:db8::1]:4711", "[2001:db8::1]"),
    ] {
        let (status, _) = raw_exchange(
            tunnel_listener,
            Some(&proxy_header(source)),
            &tunnel_get("/health", ""),
        )
        .await
        .expect("the tunnel listener answers after a PROXY header");
        assert_eq!(status, 200);
        assert_eq!(
            next_report(&mut forwarded_requests),
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
    malformed[12] = 0x11;
    assert_eq!(
        raw_exchange(
            tunnel_listener,
            Some(&malformed),
            &tunnel_get("/health", "")
        )
        .await,
        None
    );
    let (status, _) = raw_exchange(tunnel_listener, None, &tunnel_get("/health", ""))
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
