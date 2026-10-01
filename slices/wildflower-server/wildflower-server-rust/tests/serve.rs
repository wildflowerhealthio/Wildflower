//! The server's lifecycle: once `set_up` has bound the port, cancelling
//! `serve`'s shutdown token makes it return `Ok`, and the loopback port is then
//! free for a second server over the same app-data dir and the same host
//! channels, which comes up and answers `/health`. While serving, the host's
//! observers see the tunnel's liveness and each forwarded request.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gatekeeper_rust::{NoLoopbackConsentPrompt, PendingConsentHead};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
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
        app_version: "0.0.0-test".to_owned(),
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
    assert_eq!(
        tokio::time::timeout(LIFECYCLE_TIMEOUT, forwarded_requests.recv())
            .await
            .expect("the forwarded request is reported in time"),
        Some(ForwardedRequest { caller: None })
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
