//! The consent commands: the base reads the consents waiting on the running
//! servers and approves or denies them through each server's gatekeeper
//! in-process ([`RunningServerConsents`]), with no HTTP and no token in the
//! webview. Each gatekeeper call runs on a blocking thread, and its outcome
//! is logged by domain.
//!
//! A server that isn't running answers [`ConsentError::ServerNotRunning`];
//! every failure answers as `{kind, message}`. A payload Tauri can't decode
//! into the parameters is rejected by Tauri with a plain string, as for the
//! other commands.

use chrono::Utc;
use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use servers_rust::{
    ApprovalOutcome, ConsentApproval, ConsentDetails, ConsentError, ConsentKey, PendingConsent,
    RunningServerConsents,
};
use tauri_plugin_log::log;

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
    read(servers.server_units.consents(), domain, consent).await
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
    approve(servers.server_units.consents(), domain, approval).await
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
    deny(servers.server_units.consents(), domain, consent).await
}

/// Run `operation` on the server consents on a blocking thread: each is a
/// synchronous gatekeeper transaction.
async fn on_consents<T: Send + 'static>(
    consents: &RunningServerConsents,
    operation: impl FnOnce(&RunningServerConsents) -> Result<T, ConsentError> + Send + 'static,
) -> Result<T, ConsentError> {
    let consents = consents.clone();
    tokio::task::spawn_blocking(move || operation(&consents))
        .await
        .map_err(|error| {
            ConsentError::Gatekeeper(GatekeeperError::infrastructure(
                "running a consent operation",
                error,
            ))
        })?
}

async fn read(
    consents: &RunningServerConsents,
    domain: String,
    consent: ConsentKey,
) -> Result<ConsentDetails, ConsentError> {
    let read_domain = domain.clone();
    on_consents(consents, move |consents| {
        consents.read(&read_domain, &consent)
    })
    .await
    .inspect_err(|error| log::warn!("[servers] reading a consent on {domain} failed: {error}"))
}

async fn approve(
    consents: &RunningServerConsents,
    domain: String,
    approval: ConsentApproval,
) -> Result<ApprovalOutcome, ConsentError> {
    let approved_domain = domain.clone();
    let result = on_consents(consents, move |consents| {
        consents.approve(&approved_domain, approval, Utc::now())
    })
    .await;
    match &result {
        Ok(outcome) => log::info!("[servers] approved a consent on {domain}: {outcome:?}"),
        Err(error) => log::warn!("[servers] approving a consent on {domain} failed: {error}"),
    }
    result
}

async fn deny(
    consents: &RunningServerConsents,
    domain: String,
    consent: ConsentKey,
) -> Result<(), ConsentError> {
    let denied_domain = domain.clone();
    let result = on_consents(consents, move |consents| {
        consents.deny(&denied_domain, &consent)
    })
    .await;
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
        setup_gatekeeper, GatekeeperConfig, GatekeeperStore, HostOwnerConsents,
        NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
    };
    use shared_structures_rust::owner_ui::OwnerUiBase;
    use tokio::sync::watch;
    use url::Url;

    use super::*;

    const DOMAIN: &str = "ruth.relay.example.com";

    /// A gatekeeper over a temporary database, the way a server's run sets
    /// one up, with what the test reads it through.
    struct TestGatekeeper {
        consents: HostOwnerConsents,
        store: SqliteGatekeeperStore,
        _pending_consent: watch::Receiver<Option<PendingConsentHead>>,
        _owner_tokens: watch::Receiver<Option<String>>,
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
        let (owner_token_sender, owner_tokens) = watch::channel(None);
        let (pending_consent_sender, pending_consent) = watch::channel(None);
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
            &owner_token_sender,
            pending_consent_sender,
            Arc::new(NoLoopbackConsentPrompt),
        )
        .unwrap();
        TestGatekeeper {
            consents: HostOwnerConsents::new(gatekeeper.state),
            store: SqliteGatekeeperStore::new(pool).unwrap(),
            _pending_consent: pending_consent,
            _owner_tokens: owner_tokens,
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

    fn running(
        gatekeeper: &TestGatekeeper,
    ) -> (
        RunningServerConsents,
        servers_rust::RunningServerConsentsEntry,
    ) {
        let running_server_consents = RunningServerConsents::new();
        let entry = running_server_consents.enter(DOMAIN, gatekeeper.consents.clone());
        (running_server_consents, entry)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_request_is_read_and_approved_through_the_commands() {
        let gatekeeper = test_gatekeeper();
        park(&gatekeeper, "device-1", GrantType::DeviceCode);
        let (consents, _entry) = running(&gatekeeper);
        let key = ConsentKey::Device {
            user_code: "CODE-device-1".to_owned(),
        };

        let details = read(&consents, DOMAIN.to_owned(), key.clone())
            .await
            .unwrap();
        assert!(
            matches!(&details, ConsentDetails::Device { user_code, .. } if user_code == "CODE-device-1"),
            "{details:?}"
        );
        let outcome = approve(
            &consents,
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
            read(&consents, DOMAIN.to_owned(), key).await,
            Err(ConsentError::NotPending)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_authorization_request_is_denied_through_the_commands() {
        let gatekeeper = test_gatekeeper();
        park(&gatekeeper, "req-1", GrantType::AuthorizationCode);
        let (consents, _entry) = running(&gatekeeper);
        let key = ConsentKey::OAuth {
            id: "req-1".to_owned(),
        };

        let denied = deny(&consents, DOMAIN.to_owned(), key.clone()).await;

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
            deny(&consents, DOMAIN.to_owned(), key).await,
            Err(ConsentError::NotPending)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_whose_run_ended_answers_server_not_running() {
        let gatekeeper = test_gatekeeper();
        park(&gatekeeper, "req-1", GrantType::AuthorizationCode);
        let (consents, entry) = running(&gatekeeper);
        drop(entry);

        let key = ConsentKey::OAuth {
            id: "req-1".to_owned(),
        };
        let not_running = ConsentError::ServerNotRunning {
            domain: DOMAIN.to_owned(),
        };
        assert_eq!(
            read(&consents, DOMAIN.to_owned(), key.clone()).await,
            Err(not_running.clone())
        );
        assert_eq!(
            deny(&consents, DOMAIN.to_owned(), key).await,
            Err(not_running)
        );
        assert_eq!(
            gatekeeper
                .store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Pending,
            "nothing was decided"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_ended_runs_entry_leaves_the_next_runs_consents_in_place() {
        let ended_run = test_gatekeeper();
        let next_run = test_gatekeeper();
        park(&ended_run, "ended-req", GrantType::AuthorizationCode);
        park(&next_run, "next-req", GrantType::AuthorizationCode);
        let consents = RunningServerConsents::new();
        let ended_entry = consents.enter(DOMAIN, ended_run.consents.clone());
        let next_entry = consents.enter(DOMAIN, next_run.consents.clone());

        // The ended run's entry drops after the next run has put its own in.
        drop(ended_entry);

        let ended_key = ConsentKey::OAuth {
            id: "ended-req".to_owned(),
        };
        assert_eq!(
            deny(&consents, DOMAIN.to_owned(), ended_key).await,
            Err(ConsentError::NotPending),
            "the ended run's gatekeeper is out of reach"
        );
        assert_eq!(
            ended_run
                .store
                .authorization_request_by_id("ended-req")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Pending,
        );
        let next_key = ConsentKey::OAuth {
            id: "next-req".to_owned(),
        };
        assert_eq!(
            deny(&consents, DOMAIN.to_owned(), next_key.clone()).await,
            Ok(()),
            "the next run's consents are still reached"
        );

        drop(next_entry);
        assert_eq!(
            read(&consents, DOMAIN.to_owned(), next_key).await,
            Err(ConsentError::ServerNotRunning {
                domain: DOMAIN.to_owned()
            })
        );
    }
}
