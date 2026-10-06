//! A restart of the real server, the way the plugin drives one: the first run
//! is cancelled and the second asked for at once, without waiting. The second
//! run waits at the run gate for the first run's runtime to be gone, binds the
//! same loopback port without "address in use", and answers `/health`. The run
//! state the host watches never goes backwards.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use background_server_service_rust::{ServerHostContext, ServerRunState};
use gatekeeper_rust::{NoLoopbackConsentPrompt, PendingConsentHead};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflower_server_rust::{HostPorts, WildflowerServerConfig};

/// How long one run may take to come up or wind down before the test fails
/// rather than hangs. Startup indexes the FHIR SearchParameter bundle, which is
/// the slow part.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(120);

/// An on-device webview handle with no popup: the test never launches an app.
struct NoOnDeviceWebview;

impl OnDeviceWebviewHandle for NoOnDeviceWebview {
    fn open(&self, _app_id: String, _title: String, _url: String) {}
}

/// A loopback port nothing is listening on: bind an ephemeral one and release
/// it, so the server can bind it next.
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

fn spawn_run(
    context: &ServerHostContext,
    shutdown: &CancellationToken,
) -> JoinHandle<anyhow::Result<()>> {
    let context = context.clone();
    let shutdown = shutdown.clone();
    tokio::spawn(async move { context.run_server(&shutdown).await })
}

/// Wait until the run state settles on `Running`, failing on a run that stops
/// with an error instead.
async fn wait_until_running(run_state: &mut watch::Receiver<ServerRunState>) {
    let settled = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        run_state.wait_for(|state| {
            matches!(
                state,
                ServerRunState::Running | ServerRunState::Stopped { error: Some(_) }
            )
        }),
    )
    .await
    .expect("the run settles in time")
    .expect("the context holds the run-state sender")
    .clone();
    assert_eq!(settled, ServerRunState::Running);
}

async fn health_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    reqwest::get(loopback_base_url.join("health").expect("health URL"))
        .await
        .expect("GET /health reaches the server")
        .status()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_waits_for_the_previous_run_and_serves_again() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
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
    let (context, receivers) = ServerHostContext::new(
        server_config(server_dir.path().to_owned(), loopback_base_url.clone()),
        host_ports,
    );
    let mut run_state = receivers.run_state;
    let tunnel_liveness = receivers.tunnel_liveness;

    let first_shutdown = CancellationToken::new();
    let first_run = spawn_run(&context, &first_shutdown);
    wait_until_running(&mut run_state).await;
    assert_eq!(
        health_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );

    // Record every run state from here on. The watch can skip states, but
    // whatever it shows must come in order: the first run's `Stopped` never
    // after the second run's `Starting`.
    let mut history_receiver = run_state.clone();
    let history = tokio::spawn(async move {
        let mut history = Vec::new();
        while history_receiver.changed().await.is_ok() {
            let state = history_receiver.borrow_and_update().clone();
            let settled = state == ServerRunState::Running;
            history.push(state);
            if settled {
                return history;
            }
        }
        history
    });

    // The restart: cancel the first run and start the second straight away.
    first_shutdown.cancel();
    let second_shutdown = CancellationToken::new();
    let second_run = spawn_run(&context, &second_shutdown);

    tokio::time::timeout(LIFECYCLE_TIMEOUT, first_run)
        .await
        .expect("the first run returns in time once cancelled")
        .expect("the first run's task doesn't panic")
        .expect("a cancelled run returns Ok");
    wait_until_running(&mut run_state).await;
    assert_eq!(
        health_status(&loopback_base_url).await,
        reqwest::StatusCode::OK
    );

    let history = tokio::time::timeout(LIFECYCLE_TIMEOUT, history)
        .await
        .expect("the history settles")
        .expect("the history task doesn't panic");
    assert_eq!(history.last(), Some(&ServerRunState::Running));
    let first_starting = history
        .iter()
        .position(|state| *state == ServerRunState::Starting);
    let last_stopped = history
        .iter()
        .rposition(|state| matches!(state, ServerRunState::Stopped { .. }));
    if let (Some(first_starting), Some(last_stopped)) = (first_starting, last_stopped) {
        assert!(
            last_stopped < first_starting,
            "the first run stopped after the second started: {history:?}"
        );
    }
    assert!(
        !history
            .iter()
            .any(|state| matches!(state, ServerRunState::Stopped { error: Some(_) })),
        "neither run may fail: {history:?}"
    );

    second_shutdown.cancel();
    tokio::time::timeout(LIFECYCLE_TIMEOUT, second_run)
        .await
        .expect("the second run returns in time once cancelled")
        .expect("the second run's task doesn't panic")
        .expect("a cancelled run returns Ok");
    assert_eq!(*run_state.borrow(), ServerRunState::Stopped { error: None });
    assert_eq!(
        *tunnel_liveness.borrow(),
        None,
        "no tunnel liveness outlives the server"
    );
}

/// A run cancelled while an earlier run still holds the gate never starts.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_cancelled_at_the_gate_never_starts() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (host_owner_token_sender, _owner_tokens) = watch::channel(None);
    let (active_pending_consent_sender, _pending_consents) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let (context, receivers) = ServerHostContext::new(
        server_config(server_dir.path().to_owned(), loopback_base_url),
        HostPorts {
            loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
            on_device_webview_handle: Arc::new(NoOnDeviceWebview),
            host_owner_token_sender,
            active_pending_consent_sender,
        },
    );
    let mut run_state = receivers.run_state;

    let first_shutdown = CancellationToken::new();
    let first_run = spawn_run(&context, &first_shutdown);
    wait_until_running(&mut run_state).await;

    // Every state from here on: a run that started would show `Starting`.
    let history = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorder = {
        let history = Arc::clone(&history);
        let mut history_receiver = run_state.clone();
        tokio::spawn(async move {
            while history_receiver.changed().await.is_ok() {
                let state = history_receiver.borrow_and_update().clone();
                history.lock().expect("history lock").push(state);
            }
        })
    };

    let cancelled_shutdown = CancellationToken::new();
    cancelled_shutdown.cancel();
    let cancelled_run = spawn_run(&context, &cancelled_shutdown);
    first_shutdown.cancel();

    tokio::time::timeout(LIFECYCLE_TIMEOUT, first_run)
        .await
        .expect("the first run returns in time")
        .expect("the first run's task doesn't panic")
        .expect("a cancelled run returns Ok");
    tokio::time::timeout(LIFECYCLE_TIMEOUT, cancelled_run)
        .await
        .expect("the cancelled run returns in time")
        .expect("the cancelled run's task doesn't panic")
        .expect("a run cancelled at the gate returns Ok");
    recorder.abort();
    assert_eq!(*run_state.borrow(), ServerRunState::Stopped { error: None });
    let history = history.lock().expect("history lock").clone();
    assert!(
        !history.contains(&ServerRunState::Starting),
        "the cancelled run must not start: {history:?}"
    );
}
