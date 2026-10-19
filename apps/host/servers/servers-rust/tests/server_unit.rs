//! The real server as a unit: a `ServerUnit` run through `UnitRunner`, with no
//! platform bound (units run without a background session). It comes up
//! `Running`, reports its tunnel's state as the run's detail but no health
//! while its tunnel isn't connected, and leaves another server's pending consent
//! on the host's pending-consent channel alone while nothing of its own waits. Once
//! its policy turns it off, it stops with the detail cleared. Turned back on,
//! the next run sets up over the same folder, so the previous run let go of
//! its databases, and runs again. Its detail holds the run's launch minter,
//! and a server whose health is unknown isn't launchable. The newest consent
//! waiting in its authorization server is the run's detail, named for the
//! client that asks, until the run ends.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use url::Url;
use wildflowerhealthio_authorization_server::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus,
};
use wildflowerhealthio_authorization_server::{GrantStore, NewestPendingConsent, SqliteGrantStore};
use wildflowerhealthio_servers::{
    LaunchError, RunPolicy, ServerDetail, ServerLaunchMinter, ServerStatus, ServerUnit,
};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;
use wildflowerhealthio_tunnel::TunnelState;
use wildflowerhealthio_unit_runner::{
    BackgroundSessionLength, RunState, StopReason, SystemClock, UnitId, UnitRunner, UnitStatus,
};
use wildflowerhealthio_wildflower_server::{
    CertificateAuthority, CertificateState, DeviceCertificateConfig, WildflowerServerConfig,
};

/// How long a run may take to come up or wind down before the test fails
/// rather than hangs. Startup indexes the FHIR SearchParameter bundle, which
/// is the slow part.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(120);

/// The server's domain, and so its unit id.
const DOMAIN: &str = "test.relay.invalid";

fn server_config(server_dir: PathBuf) -> WildflowerServerConfig {
    WildflowerServerConfig {
        search_parameter_data_dir: PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../wildflower-server/fhir-r4-rust/assets"
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
        // reachability monitor finds the server unreachable.
        relay_settings: wildflowerhealthio_tunnel::RelaySettings {
            remote_addr: "127.0.0.1:9".to_owned(),
            token: "test-tunnel-token".to_owned(),
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            service_name: "test".to_owned(),
        },
        domain: DOMAIN.to_owned(),
        device_certificate: DeviceCertificateConfig {
            // A CA nothing answers at: the order fails and is retried in the
            // background, which the server's lifecycle doesn't wait on.
            certificate_authority: CertificateAuthority::UnreachableForTests,
            certificate_dir: server_dir.join("certificates"),
            acme_account_dir: server_dir.join("acme-account"),
        },
        runtime: ServerRuntimeConfig { server_dir },
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

/// A server set on a fresh `UnitRunner` with the `Always` policy, and what
/// the test reads it through.
struct ServerOnARunner {
    unit_runner: Arc<UnitRunner<ServerDetail>>,
    _server_dir: tempfile::TempDir,
}

/// A server in a fresh folder, set on a runner.
fn server_on_a_runner() -> ServerOnARunner {
    server_in_a_folder_on_a_runner(tempfile::tempdir().expect("temp server folder"))
}

/// The server whose folder is `server_dir`, set on a runner.
fn server_in_a_folder_on_a_runner(server_dir: tempfile::TempDir) -> ServerOnARunner {
    let config = server_config(server_dir.path().to_owned());

    let unit_runner = UnitRunner::<ServerDetail>::new(
        tokio::runtime::Handle::current(),
        Arc::new(SystemClock),
        BackgroundSessionLength::AsLongAsNeeded,
    );
    unit_runner.set_unit(UnitId::from(DOMAIN), RunPolicy::Always, move || {
        Ok(ServerUnit::new(config.clone()))
    });
    ServerOnARunner {
        unit_runner,
        _server_dir: server_dir,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_unit_runs_reports_its_health_and_runs_again_after_a_stop() {
    let server = server_on_a_runner();
    let unit_runner = &server.unit_runner;

    wait_for(unit_runner, "running", |status| {
        status.run_state == RunState::Running
    })
    .await;
    // No relay serves the domain, so the tunnel never connects and the
    // monitor never probes: the run's detail holds no health.
    wait_for(unit_runner, "holding its launch minter", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.launch_minter.is_some())
    })
    .await;
    // Nothing listens at the relay's address, so the tunnel's first dial
    // fails and it backs off to dial again, which the detail reports.
    let reconnecting = wait_for(unit_runner, "reporting its tunnel reconnecting", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| matches!(detail.tunnel, Some(TunnelState::Reconnecting { .. })))
    })
    .await;
    assert!(
        reconnecting
            .detail
            .as_ref()
            .is_some_and(|detail| detail.health.is_none()),
        "a tunnel that isn't connected is never probed"
    );
    // The run's detail holds its launch minter, which mints through the
    // run's authorization server; a server whose health is unknown isn't launchable,
    // and a tunnel that is dialing again doesn't change why.
    let launch_minter = unit_runner.statuses()[&UnitId::from(DOMAIN)]
        .detail
        .as_ref()
        .and_then(|detail| detail.launch_minter.clone())
        .expect("the run's detail holds its launch minter");
    let launch = tokio::task::block_in_place(|| launch_minter.mint()).expect("a launch");
    assert!(!launch.is_empty());
    // And its sign-in code minter, which mints through the same run's
    // authorization server.
    let sign_in_code_minter = unit_runner.statuses()[&UnitId::from(DOMAIN)]
        .detail
        .as_ref()
        .and_then(|detail| detail.sign_in_code_minter.clone())
        .expect("the run's detail holds its sign-in code minter");
    assert!(!sign_in_code_minter.mint().is_empty());
    let unit_status = unit_runner.statuses()[&UnitId::from(DOMAIN)].clone();
    // Unknown health is refused before the certificate is looked at, so a
    // run that hasn't reported one yet is given any.
    let status = ServerStatus {
        domain: DOMAIN.to_owned(),
        certificate: ServerStatus::run_certificate(&unit_status)
            .cloned()
            .unwrap_or_else(|| {
                CertificateState::of_unreadable_cache(
                    CertificateAuthority::UnreachableForTests,
                    "not read".to_owned(),
                )
            }),
        unit_status,
    };
    assert!(matches!(
        ServerLaunchMinter::of_launchable_server(&status),
        Err(LaunchError::NotYetProbed { .. })
    ));

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
    assert_eq!(
        stopped.detail, None,
        "no health or tunnel state outlives the run"
    );

    unit_runner.set_unit_policy(&UnitId::from(DOMAIN), RunPolicy::Always);
    wait_for(
        unit_runner,
        "running again, with its launch minter",
        |status| {
            status.run_state == RunState::Running
                && status
                    .detail
                    .as_ref()
                    .is_some_and(|detail| detail.launch_minter.is_some())
        },
    )
    .await;

    unit_runner.remove_unit(&UnitId::from(DOMAIN)).await;
    assert!(unit_runner.statuses().is_empty());
}

/// Wait in the authorization server's database in `server_dir` for the
/// Owner's answer to `count` device requests from the host app's client, as a
/// device pairing with the server leaves them, each requested after the one
/// before, and answer with the codes their user would type, oldest first. The
/// server isn't running, so it reads them as its run starts.
fn park_device_requests(server_dir: &std::path::Path, count: usize) -> Vec<String> {
    // The server's shared database (`WILDFLOWER_DB` in `set_up`); opening the
    // store runs its migrations, as the run would.
    let pool = wildflowerhealthio_persistence::open_pool(&server_dir.join("wildflower.sqlite"))
        .expect("open the server's database");
    let store = SqliteGrantStore::new(pool).expect("grant store");
    (0..count)
        .map(|index| {
            let user_code = format!("WILD-000{index}");
            let requested_at = chrono::Utc::now() + chrono::Duration::milliseconds(index as i64);
            store
                .insert_authorization_request(&AuthorizationRequest {
                    id: format!("device-code-{index}"),
                    grant_type: GrantType::DeviceCode,
                    client_id:
                        wildflowerhealthio_authorization_server::WILDFLOWER_HOST_APP_CLIENT_ID
                            .to_owned(),
                    requested_scopes: vec!["openid".to_owned()],
                    code_challenge: None,
                    code_challenge_method: None,
                    redirect_uri: None,
                    client_state: None,
                    user_code: Some(user_code.clone()),
                    pre_approved_scopes: Vec::new(),
                    requested_at,
                    expires_at: requested_at + chrono::Duration::minutes(10),
                    last_polled_at: None,
                    status: RequestStatus::Pending,
                    granted_scopes: None,
                    patient: None,
                    device_name: None,
                    launch: None,
                    launch_bound_patient: None,
                    decidable_in_requesting_browser: false,
                    sid: None,
                    session_shortfall_acknowledged: true,
                })
                .expect("park a device request");
            user_code
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_servers_newest_consent_is_its_detail_named_for_its_client() {
    let server_dir = tempfile::tempdir().expect("temp server folder");
    let user_codes = park_device_requests(server_dir.path(), 2);
    let server = server_in_a_folder_on_a_runner(server_dir);
    let unit_runner = &server.unit_runner;
    wait_for(unit_runner, "running", |status| {
        status.run_state == RunState::Running
    })
    .await;

    // The host app's client is seeded as the run sets its server up, so the
    // newest request carries its registered name.
    let newest = NewestPendingConsent::Device {
        user_code: user_codes[1].clone(),
        client_name: "Wildflower Host".to_owned(),
    };
    wait_for(unit_runner, "reporting the newest request", |status| {
        status
            .detail
            .as_ref()
            .is_some_and(|detail| detail.pending_consent.as_ref() == Some(&newest))
    })
    .await;

    unit_runner.set_unit_policy(&UnitId::from(DOMAIN), RunPolicy::Off);
    wait_for(unit_runner, "stopped with its detail cleared", |status| {
        matches!(status.run_state, RunState::Stopped { last_stop: Some(_) })
            && status.detail.is_none()
    })
    .await;
    unit_runner.remove_unit(&UnitId::from(DOMAIN)).await;
}
