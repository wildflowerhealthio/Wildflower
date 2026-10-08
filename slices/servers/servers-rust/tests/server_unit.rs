//! The real server as a unit: a `ServerUnit` run through `UnitRunner`, with no
//! platform bound (units run without a background session). It comes up
//! `Running` and answers `/health` on its loopback port, reports its health
//! as the run's detail, and once its policy turns it off, stops with the
//! detail cleared. Turned back on, the next run binds the same port, so the
//! previous run's runtime is gone, and serves again. A consent its gatekeeper
//! parks is the run's detail, and is read and decided through the host's
//! `RunningServerConsents` until the run ends.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gatekeeper_rust::{NoLoopbackConsentPrompt, PendingConsentHead};
use servers_rust::{
    ApprovalOutcome, ConsentApproval, ConsentDetails, ConsentError, ConsentKey, RunPolicy,
    RunningServerConsents, ServerDetail, ServerUnit,
};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::sync::{mpsc, watch};
use unit_runner::{RunState, StopReason, SystemClock, UnitId, UnitRunner, UnitStatus};
use url::Url;
use wildflower_server_rust::{DeviceCertificateConfig, HostPorts, WildflowerServerConfig};

/// How long a run may take to come up or wind down before the test fails
/// rather than hangs. Startup indexes the FHIR SearchParameter bundle, which
/// is the slow part.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(120);

/// The server's domain, and so its unit id.
const DOMAIN: &str = "test.relay.invalid";

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
        // background, which the server's lifecycle doesn't wait on, and the
        // reachability monitor finds the server unreachable.
        relay_settings: tunnel_rust::RelaySettings {
            remote_addr: "127.0.0.1:9".to_owned(),
            token: "test-tunnel-token".to_owned(),
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            service_name: "test".to_owned(),
        },
        public_host: DOMAIN.to_owned(),
        device_certificate: DeviceCertificateConfig {
            // A CA nothing answers at: the order fails and is retried in the
            // background, which the server's lifecycle doesn't wait on.
            acme_directory_url: Url::parse("https://127.0.0.1:9/directory")
                .expect("the CA directory URL"),
            certificate_dir: server_dir.join("certificates"),
            acme_account_dir: server_dir.join("acme-account"),
        },
        runtime: ServerRuntimeConfig {
            loopback_base_url,
            server_dir,
        },
    }
}

/// Wait until the server's status satisfies `predicate`, failing the test
/// after [`LIFECYCLE_TIMEOUT`], or at once on a run that failed.
async fn wait_for(
    unit_runner: &UnitRunner<ServerDetail>,
    what: &str,
    predicate: impl Fn(&UnitStatus<ServerDetail>) -> bool,
) -> UnitStatus<ServerDetail> {
    let unit_id = UnitId::from(DOMAIN);
    let mut statuses = unit_runner.subscribe();
    let waited = tokio::time::timeout(
        LIFECYCLE_TIMEOUT,
        statuses.wait_for(|statuses| {
            let status = statuses.get(&unit_id).expect("the server is set");
            if let RunState::Stopped {
                last_stop: Some(stop),
            } = &status.run_state
            {
                assert_ne!(
                    stop.reason,
                    StopReason::EndedOnItsOwn,
                    "the run failed: {stop:?}"
                );
            }
            predicate(status)
        }),
    )
    .await;
    match waited {
        Ok(Ok(statuses)) => statuses.get(&unit_id).cloned().expect("just matched"),
        Ok(Err(_)) => panic!("the statuses closed while waiting for the server to be {what}"),
        Err(_) => panic!(
            "the server never became {what}; it is {:?}",
            unit_runner.statuses().get(&unit_id)
        ),
    }
}

async fn health_status(loopback_base_url: &Url) -> reqwest::StatusCode {
    reqwest::get(loopback_base_url.join("health").expect("health URL"))
        .await
        .expect("GET /health reaches the server")
        .status()
}

/// A server set on a fresh `UnitRunner` with the `Always` policy, and what
/// the test reads it through.
struct ServerOnARunner {
    unit_runner: Arc<UnitRunner<ServerDetail>>,
    loopback_base_url: Url,
    running_server_consents: RunningServerConsents,
    /// The host's pending-consent channel, which every run forwards its head to.
    host_pending_consents: watch::Receiver<Option<PendingConsentHead>>,
    /// Held so gatekeeper can publish the host owner token.
    _owner_tokens: watch::Receiver<Option<String>>,
    _server_dir: tempfile::TempDir,
}

fn server_on_a_runner() -> ServerOnARunner {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let loopback_base_url = Url::parse(&format!("http://127.0.0.1:{}/", free_loopback_port()))
        .expect("loopback base URL");
    let (host_owner_token_tx, owner_tokens) = watch::channel(None);
    let (active_pending_consent_tx, host_pending_consents) =
        watch::channel::<Option<PendingConsentHead>>(None);
    let host_ports = HostPorts {
        loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
        on_device_webview_handle: Arc::new(NoOnDeviceWebview),
        host_owner_token_tx,
        active_pending_consent_tx,
    };
    let (forwarded_request_tx, _forwarded_request_rx) = mpsc::channel(16);
    let config = server_config(server_dir.path().to_owned(), loopback_base_url.clone());
    let running_server_consents = RunningServerConsents::new();

    let unit_runner =
        UnitRunner::<ServerDetail>::new(tokio::runtime::Handle::current(), Arc::new(SystemClock));
    let unit_consents = running_server_consents.clone();
    unit_runner.set_unit(UnitId::from(DOMAIN), RunPolicy::Always, move || {
        Ok(ServerUnit::new(
            config.clone(),
            host_ports.clone(),
            forwarded_request_tx.clone(),
            unit_consents.clone(),
        ))
    });
    ServerOnARunner {
        unit_runner,
        loopback_base_url,
        running_server_consents,
        host_pending_consents,
        _owner_tokens: owner_tokens,
        _server_dir: server_dir,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_unit_runs_reports_its_health_and_runs_again_after_a_stop() {
    let server = server_on_a_runner();
    let ServerOnARunner {
        unit_runner,
        loopback_base_url,
        ..
    } = &server;

    wait_for(unit_runner, "running", |status| {
        status.run_state == RunState::Running
    })
    .await;
    assert_eq!(
        health_status(loopback_base_url).await,
        reqwest::StatusCode::OK
    );
    // No relay serves the public host, so the monitor finds it unreachable,
    // and the run reports that as its detail.
    wait_for(unit_runner, "reporting its health", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.health.is_some())
    })
    .await;

    unit_runner.set_unit_policy(&UnitId::from(DOMAIN), RunPolicy::Off);
    let stopped = wait_for(unit_runner, "stopped", |status| {
        matches!(status.run_state, RunState::Stopped { last_stop: Some(_) })
    })
    .await;
    let RunState::Stopped {
        last_stop: Some(stop),
    } = stopped.run_state
    else {
        unreachable!("just matched");
    };
    assert_eq!(stop.reason, StopReason::PolicyInactive);
    assert_eq!(stop.error, None);
    assert_eq!(stopped.detail, None, "no health outlives the run");

    unit_runner.set_unit_policy(&UnitId::from(DOMAIN), RunPolicy::Always);
    wait_for(unit_runner, "running again", |status| {
        status.run_state == RunState::Running
    })
    .await;
    assert_eq!(
        health_status(loopback_base_url).await,
        reqwest::StatusCode::OK
    );

    unit_runner.remove_unit(&UnitId::from(DOMAIN)).await;
    assert!(unit_runner.statuses().is_empty());
}

/// Ask the server for a device code, as a device pairing with it does, and
/// answer with the code its user would type.
async fn start_device_authorization(loopback_base_url: &Url) -> String {
    let response = reqwest::Client::new()
        .post(
            loopback_base_url
                .join("oauth/device_authorization")
                .expect("device authorization URL"),
        )
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!(
            "client_id={}&scope=system%2F*.cruds",
            gatekeeper_rust::FIRST_PARTY_CLIENT_ID
        ))
        .send()
        .await
        .expect("POST /oauth/device_authorization reaches the server");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.expect("a JSON body");
    body["user_code"].as_str().expect("a user code").to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_servers_consents_are_its_detail_and_are_decided_through_the_host() {
    let server = server_on_a_runner();
    let unit_runner = &server.unit_runner;
    wait_for(unit_runner, "running", |status| {
        status.run_state == RunState::Running
    })
    .await;

    let mut user_codes = Vec::new();
    for _ in 0..2 {
        user_codes.push(start_device_authorization(&server.loopback_base_url).await);
    }
    let first = PendingConsentHead::Device {
        user_code: user_codes[0].clone(),
    };
    wait_for(unit_runner, "reporting the first request", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.pending_consent.as_ref() == Some(&first))
    })
    .await;
    assert_eq!(
        *server.host_pending_consents.borrow(),
        Some(first),
        "the run forwards its head to the host's channel"
    );

    let first_key = ConsentKey::Device {
        user_code: user_codes[0].clone(),
    };
    let details =
        tokio::task::block_in_place(|| server.running_server_consents.read(DOMAIN, &first_key))
            .expect("the first request");
    let ConsentDetails::Device {
        user_code,
        client_id,
        requested_scopes,
        ..
    } = details
    else {
        panic!("a device request reads as one: {details:?}");
    };
    assert_eq!(user_code, user_codes[0]);
    assert_eq!(client_id, gatekeeper_rust::FIRST_PARTY_CLIENT_ID);
    assert_eq!(requested_scopes, ["system/*.cruds"]);

    let outcome = tokio::task::block_in_place(|| {
        server.running_server_consents.approve(
            DOMAIN,
            ConsentApproval::Device {
                user_code: user_codes[0].clone(),
                approved_scopes: vec!["system/*.cruds".to_owned()],
                patient: None,
            },
            chrono::Utc::now(),
        )
    });
    assert_eq!(outcome, Ok(ApprovalOutcome::Approved));
    let second = PendingConsentHead::Device {
        user_code: user_codes[1].clone(),
    };
    wait_for(unit_runner, "reporting the second request", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.pending_consent.as_ref() == Some(&second))
    })
    .await;

    let second_key = ConsentKey::Device {
        user_code: user_codes[1].clone(),
    };
    tokio::task::block_in_place(|| server.running_server_consents.deny(DOMAIN, &second_key))
        .expect("deny the second request");
    wait_for(unit_runner, "reporting nothing waiting", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.pending_consent.is_none())
    })
    .await;
    assert_eq!(
        tokio::task::block_in_place(|| server.running_server_consents.deny(DOMAIN, &second_key)),
        Err(ConsentError::NotPending)
    );

    unit_runner.set_unit_policy(&UnitId::from(DOMAIN), RunPolicy::Off);
    wait_for(unit_runner, "stopped", |status| {
        matches!(status.run_state, RunState::Stopped { last_stop: Some(_) })
    })
    .await;
    assert_eq!(
        server.running_server_consents.read(DOMAIN, &first_key),
        Err(ConsentError::ServerNotRunning {
            domain: DOMAIN.to_owned()
        }),
        "a stopped server's consents are out of reach"
    );
    unit_runner.remove_unit(&UnitId::from(DOMAIN)).await;
}
