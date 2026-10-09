//! The consent commands: the base reads the consents waiting on the running
//! servers and approves or denies them through each run's gatekeeper
//! in-process (the [`ServerConsentDecider`] in the run's detail), with no HTTP
//! and no token in the webview. Each gatekeeper call runs on a blocking
//! thread, and its outcome is logged by domain.
//!
//! A server that isn't running answers [`ConsentError::ServerNotRunning`];
//! every failure answers as `{kind, message}`. A payload Tauri can't decode
//! into the parameters is rejected by Tauri with a plain string, as for the
//! other commands.

use chrono::Utc;
use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use servers_rust::{
    ApprovalOutcome, ConsentApproval, ConsentDetails, ConsentError, ConsentKey, PendingConsent,
    ServerConsentDecider, ServerDetail,
};
use tauri_plugin_log::log;
use tauri_unit_runner::UnitStatuses;

use crate::ServersState;

/// The oldest consent waiting on each running server that has one, in domain
/// order. Invoked as `invoke('pending_consents_list')`; the
/// [`PENDING_CONSENT_EVENT`](crate::PENDING_CONSENT_EVENT) carries each
/// change after.
#[tauri::command]
#[must_use]
pub fn pending_consents_list(servers: tauri::State<'_, ServersState>) -> Vec<PendingConsent> {
    PendingConsent::waiting(&servers.server_units.statuses())
}

/// The consent `consent` waiting on the server `domain`, as the base shows
/// it. Invoked as `invoke('server_consent_get', { domain, consent })`,
/// `consent` a [`ConsentKey`].
///
/// # Errors
///
/// The [`ConsentError`] that stopped it.
#[tauri::command]
pub async fn server_consent_get(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    consent: ConsentKey,
) -> Result<ConsentDetails, ConsentError> {
    read(&servers.server_units.statuses(), domain, consent).await
}

/// Approve a consent waiting on the server `domain` as the host's Owner.
/// Invoked as `invoke('server_consent_approve', { domain, approval })`,
/// `approval` a [`ConsentApproval`]; answers with whether anything was
/// granted.
///
/// # Errors
///
/// The [`ConsentError`] that stopped it.
#[tauri::command]
pub async fn server_consent_approve(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    approval: ConsentApproval,
) -> Result<ApprovalOutcome, ConsentError> {
    approve(&servers.server_units.statuses(), domain, approval).await
}

/// Deny the consent `consent` waiting on the server `domain`. Invoked as
/// `invoke('server_consent_deny', { domain, consent })`; answers with
/// nothing.
///
/// # Errors
///
/// The [`ConsentError`] that stopped it.
#[tauri::command]
pub async fn server_consent_deny(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    consent: ConsentKey,
) -> Result<(), ConsentError> {
    deny(&servers.server_units.statuses(), domain, consent).await
}

/// Run `operation` on a blocking thread, on the decider of the server
/// `domain`'s run as `statuses` hold it: each is a synchronous gatekeeper
/// transaction.
async fn on_decider<T: Send + 'static>(
    statuses: &UnitStatuses<ServerDetail>,
    domain: &str,
    operation: impl FnOnce(&ServerConsentDecider) -> Result<T, ConsentError> + Send + 'static,
) -> Result<T, ConsentError> {
    let decider = ServerConsentDecider::of_running_server(statuses, domain)?;
    tokio::task::spawn_blocking(move || operation(&decider))
        .await
        .map_err(|error| {
            ConsentError::Gatekeeper(GatekeeperError::infrastructure(
                "running a consent operation",
                error,
            ))
        })?
}

async fn read(
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    consent: ConsentKey,
) -> Result<ConsentDetails, ConsentError> {
    on_decider(statuses, &domain, move |decider| decider.read(&consent))
        .await
        .inspect_err(|error| log::warn!("[servers] reading a consent on {domain} failed: {error}"))
}

async fn approve(
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    approval: ConsentApproval,
) -> Result<ApprovalOutcome, ConsentError> {
    let result = on_decider(statuses, &domain, move |decider| {
        decider.approve(approval, Utc::now())
    })
    .await;
    match &result {
        Ok(outcome) => log::info!("[servers] approved a consent on {domain}: {outcome:?}"),
        Err(error) => log::warn!("[servers] approving a consent on {domain} failed: {error}"),
    }
    result
}

async fn deny(
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    consent: ConsentKey,
) -> Result<(), ConsentError> {
    let result = on_decider(statuses, &domain, move |decider| decider.deny(&consent)).await;
    match &result {
        Ok(()) => log::info!("[servers] denied a consent on {domain}"),
        Err(error) => log::warn!("[servers] denying a consent on {domain} failed: {error}"),
    }
    result
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Duration;
    use gatekeeper_rust::domain::authorization_request::{
        AuthorizationRequest, GrantType, RequestStatus,
    };
    use gatekeeper_rust::{
        setup_gatekeeper, GatekeeperConfig, GatekeeperStore, HostConsentDecider,
        NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
    };
    use shared_structures_rust::owner_ui::OwnerUiBase;
    use tauri_unit_runner::{RunState, UnitId, UnitStatus};
    use tokio::sync::watch;
    use url::Url;

    use super::*;

    const DOMAIN: &str = "ruth.relay.example.com";

    /// A gatekeeper over a temporary database, the way a server's run sets
    /// one up, with what the test reads it through.
    struct TestGatekeeper {
        consent_decider: HostConsentDecider,
        store: SqliteGatekeeperStore,
        _pending_consent_rx: watch::Receiver<Option<PendingConsentHead>>,
        _owner_token_rx: watch::Receiver<Option<String>>,
        _database_dir: tempfile::TempDir,
    }

    fn test_gatekeeper() -> TestGatekeeper {
        let database_dir = tempfile::tempdir().unwrap();
        let pool =
            persistence_rust::open_pool(&database_dir.path().join("wildflower.sqlite")).unwrap();
        let revocation_store = token_revocation_rust::RevocationStore::new(
            persistence_rust::Connection::open_in_memory().unwrap(),
        )
        .unwrap();
        let (owner_token_tx, owner_token_rx) = watch::channel(None);
        let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
        let gatekeeper = setup_gatekeeper(
            pool.clone(),
            revocation_store,
            &GatekeeperConfig {
                loopback_base_url: Url::parse("http://127.0.0.1:8080/").unwrap(),
                server_origin: Url::parse(&format!("https://{DOMAIN}")).unwrap(),
                host_owner_scopes: gatekeeper_rust::default_local_granted_scopes(),
                first_party_client_id: gatekeeper_rust::default_first_party_client_id(),
                owner_ui_base: OwnerUiBase::parse("https://owner-ui.test/app/").unwrap(),
            },
            &owner_token_tx,
            pending_consent_tx,
            Arc::new(NoLoopbackConsentPrompt),
        )
        .unwrap();
        TestGatekeeper {
            consent_decider: HostConsentDecider::new(gatekeeper.state),
            store: SqliteGatekeeperStore::new(pool).unwrap(),
            _pending_consent_rx: pending_consent_rx,
            _owner_token_rx: owner_token_rx,
            _database_dir: database_dir,
        }
    }

    /// Park a pending request on the gatekeeper's store, as its `/oauth/*`
    /// routes do.
    fn park(gatekeeper: &TestGatekeeper, id: &str, grant_type: GrantType) {
        let now = chrono::Utc::now();
        let is_device = grant_type == GrantType::DeviceCode;
        gatekeeper
            .store
            .insert_authorization_request(&AuthorizationRequest {
                id: id.to_owned(),
                grant_type,
                client_id: gatekeeper_rust::FIRST_PARTY_CLIENT_ID.to_owned(),
                requested_scopes: vec!["system/*.cruds".to_owned()],
                code_challenge: (!is_device).then(|| "challenge".to_owned()),
                code_challenge_method: (!is_device).then(|| "S256".to_owned()),
                redirect_uri: (!is_device).then(|| Url::parse("https://app.example/cb").unwrap()),
                client_state: None,
                user_code: is_device.then(|| format!("CODE-{id}")),
                pre_approved_scopes: Vec::new(),
                requested_at: now,
                expires_at: now + Duration::minutes(5),
                last_polled_at: None,
                status: RequestStatus::Pending,
                granted_scopes: None,
                patient: None,
                device_name: None,
                launch: None,
                launch_bound_patient: None,
            })
            .unwrap();
    }

    /// The servers' statuses with the server's run up over `gatekeeper`.
    fn running(gatekeeper: &TestGatekeeper) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
            health: None,
            certificate: None,
            pending_consent: None,
            consent_decider: Some(ServerConsentDecider::new(
                gatekeeper.consent_decider.clone(),
            )),
        };
        let status = UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(detail),
        };
        [(UnitId::new(DOMAIN), status)].into()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_request_is_read_and_approved_through_the_commands() {
        let gatekeeper = test_gatekeeper();
        park(&gatekeeper, "device-1", GrantType::DeviceCode);
        let statuses = running(&gatekeeper);
        let key = ConsentKey::Device {
            user_code: "CODE-device-1".to_owned(),
        };

        let details = read(&statuses, DOMAIN.to_owned(), key.clone())
            .await
            .unwrap();
        assert!(
            matches!(&details, ConsentDetails::Device { user_code, .. } if user_code == "CODE-device-1"),
            "{details:?}"
        );
        let outcome = approve(
            &statuses,
            DOMAIN.to_owned(),
            ConsentApproval::Device {
                user_code: "CODE-device-1".to_owned(),
                approved_scopes: vec!["system/*.cruds".to_owned()],
                patient: None,
            },
        )
        .await;

        assert_eq!(outcome, Ok(ApprovalOutcome::Approved));
        assert_eq!(
            gatekeeper
                .store
                .authorization_request_by_id("device-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Approved
        );
        assert_eq!(
            read(&statuses, DOMAIN.to_owned(), key).await,
            Err(ConsentError::NotPending)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_authorization_request_is_denied_through_the_commands() {
        let gatekeeper = test_gatekeeper();
        park(&gatekeeper, "req-1", GrantType::AuthorizationCode);
        let statuses = running(&gatekeeper);
        let key = ConsentKey::OAuth {
            id: "req-1".to_owned(),
        };

        let denied = deny(&statuses, DOMAIN.to_owned(), key.clone()).await;

        assert_eq!(denied, Ok(()));
        assert_eq!(
            gatekeeper
                .store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied
        );
        assert_eq!(
            deny(&statuses, DOMAIN.to_owned(), key).await,
            Err(ConsentError::NotPending)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_with_no_run_up_answers_server_not_running() {
        // No run has set the server's detail, or the run ended and
        // `UnitRunner` cleared it.
        let statuses: UnitStatuses<ServerDetail> =
            [(UnitId::new(DOMAIN), UnitStatus::never_run())].into();
        let key = ConsentKey::OAuth {
            id: "req-1".to_owned(),
        };
        let not_running = ConsentError::ServerNotRunning {
            domain: DOMAIN.to_owned(),
        };

        assert_eq!(
            read(&statuses, DOMAIN.to_owned(), key.clone()).await,
            Err(not_running.clone())
        );
        assert_eq!(
            deny(&statuses, DOMAIN.to_owned(), key).await,
            Err(not_running)
        );
    }
}
