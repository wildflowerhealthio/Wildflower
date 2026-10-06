//! The server's lifecycle: `set_up` creates the server's folder and opens its
//! databases there, and once it has bound the port, cancelling `serve`'s
//! shutdown token makes it return `Ok`. The loopback port is then free for a
//! second server over the same folder and the same host channels, which comes
//! up and answers `/health`. While serving, the host's observers see the
//! tunnel's liveness and each forwarded request, and the request log records
//! each forwarded request and serves it back on `/requests` to a token holding
//! the request log's read scope.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gatekeeper_rust::domain::token::{mint_access_token, NewJwtArgs};
use gatekeeper_rust::{
    GatekeeperStore, NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
};
use serde_json::Value;
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflower_server_rust::{set_up, HostPorts, ServerObservers, WildflowerServerConfig};

/// The `Forwarded` header the trusted front stamps on a request it relayed
/// through the tunnel, from client `192.0.2.1` to `demo.example.com`.
const FORWARDED: &str = "for=192.0.2.1;host=demo.example.com;proto=https";

/// The origin [`FORWARDED`] names: the audience of a client token for it.
const FORWARDED_ORIGIN: &str = "https://demo.example.com";

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
        // background, which the server's lifecycle doesn't wait on.
        relay_settings: tunnel_rust::RelaySettings {
            remote_addr: "127.0.0.1:9".to_owned(),
            token: "test-tunnel-token".to_owned(),
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            service_name: "test".to_owned(),
        },
        public_host: "test.relay.example.com".to_owned(),
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
    assert_eq!(
        health_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );
    // The loopback `/health` above is not reported; a forwarded one is, with no
    // caller (`/health` is ungated).
    let forwarded_health = reqwest::Client::new()
        .get(loopback_base_url.join("health").expect("health URL"))
        .header("forwarded", FORWARDED)
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

/// A client token for [`FORWARDED_ORIGIN`] granting `scopes`, signed with the
/// key gatekeeper keeps in the server's database under `app_data_dir`.
fn client_token(app_data_dir: &Path, scopes: &[String]) -> String {
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
            issuer: shared_structures_rust::CANONICAL_ISSUER,
            audience: Some(FORWARDED_ORIGIN),
            patient: None,
            is_host_owner: false,
        },
    )
    .expect("mint a client token")
}

/// `GET /requests` relayed through the tunnel, with `bearer_token` when given.
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

/// Whether the request log, read with `bearer_token`, holds a `GET /health`
/// relayed from `192.0.2.1`.
async fn request_log_holds_forwarded_health(loopback_base_url: &Url, bearer_token: &str) -> bool {
    let response = forwarded_request_log_read(loopback_base_url, Some(bearer_token)).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let page: Value = response.json().await.expect("a JSON request-log page");
    page["requests"]
        .as_array()
        .expect("a requests array")
        .iter()
        .any(|logged| logged["path"] == "/health" && logged["address"] == "192.0.2.1")
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
    let (forwarded_request_sender, _forwarded_requests) = mpsc::channel(8);
    let observers = ServerObservers {
        tunnel_liveness_sender,
        forwarded_request_sender,
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
    let request_log_reader = client_token(
        app_data_dir.path(),
        &request_log_rust::grantable_request_log_scopes()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
    );
    let apps_reader = client_token(app_data_dir.path(), &["wildflower/Apps.r".to_owned()]);

    let forwarded_health = reqwest::Client::new()
        .get(loopback_base_url.join("health").expect("health URL"))
        .header("forwarded", FORWARDED)
        .send()
        .await
        .expect("a forwarded GET /health reaches the server");
    assert_eq!(forwarded_health.status(), reqwest::StatusCode::OK);

    // The writer records off the request path, so the row lands a moment after
    // the response; read until it does.
    tokio::time::timeout(LIFECYCLE_TIMEOUT, async {
        while !request_log_holds_forwarded_health(&loopback_base_url, &request_log_reader).await {
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

    shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, serving)
        .await
        .expect("serve returns in time once cancelled")
        .expect("the serve task doesn't panic")
        .expect("a cancelled serve returns Ok");
}
