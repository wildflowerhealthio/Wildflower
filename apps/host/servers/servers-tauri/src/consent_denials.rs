//! Denying a consent from its notification: the Deny on a server's consent
//! notification, and on the ongoing one on Android, denies the request that
//! notification named, with the run's own Owner authority
//! ([`ServerConsentDenier`](wildflowerhealthio_servers::ServerConsentDenier)),
//! without opening a page. The requester's wait then ends as denied.

use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{ConsentRequest, ServerDetail};
use wildflowerhealthio_tauri_unit_runner::{UnitId, UnitStatuses};

use crate::ServersState;

/// Deny the request the notification the plugin posted under
/// `notificationId` named, as an action on it reports it: a server's own
/// consent notification's, or the ongoing one's, as the consent
/// notifications last recorded them
/// ([`AnnouncedConsents`](wildflowerhealthio_servers::AnnouncedConsents)), so
/// the Deny never reaches a request that came since. Invoked as
/// `invoke('server_deny_notified_consent', { notificationId })`; answers with
/// nothing at once, and denies once the server's run reports, as
/// [`deny_consent_once_reporting`] waits for it, logging the outcome. A
/// notification that names no request denies nothing.
///
/// Like a tap, it ends the arrival's wait for a server's first report, so
/// the arrival in the foreground the action may bring opens nothing for it,
/// and takes the notification down with the consent notifications, as the
/// platform takes a notification down when one of its actions is tapped.
#[tauri::command]
pub fn server_deny_notified_consent(servers: tauri::State<'_, ServersState>, notification_id: i32) {
    let server_units = servers.server_units.clone();
    let Some(request) = server_units
        .announced_consents()
        .request_of_notification(notification_id)
        .cloned()
    else {
        log::info!("[servers] notification {notification_id} names no request to deny");
        return;
    };
    server_units.notification_tapped(notification_id);
    let statuses_rx = server_units.subscribe_statuses();
    tauri::async_runtime::spawn(async move {
        deny_consent_once_reporting(statuses_rx, &request).await;
    });
}

/// Deny `request` on its server once a run of it reports, with the statuses
/// `statuses_rx` holds, now and on each change until one does: a run that
/// isn't reporting, as one stopping, stopped or starting, is waited for. The
/// request named is the one denied, never one newer, so a denial that waits
/// for a run that starts much later denies only that request, if it still
/// waits. Ends once the server is gone or the statuses close. The outcome is
/// logged: a request already decided or expired stays as it was, which the
/// authorization server reports as not found.
pub(crate) async fn deny_consent_once_reporting(
    mut statuses_rx: watch::Receiver<UnitStatuses<ServerDetail>>,
    request: &ConsentRequest,
) {
    let domain = &request.domain;
    let unit_id = UnitId::new(domain);
    let consent_denier = loop {
        let detail = {
            let statuses = statuses_rx.borrow_and_update();
            let Some(unit_status) = statuses.get(&unit_id) else {
                log::info!("[servers] {domain} is gone; its consent isn't denied");
                return;
            };
            unit_status.detail.clone()
        };
        if let Some(detail) = detail {
            break detail.consent_denier;
        }
        if statuses_rx.changed().await.is_err() {
            log::warn!("[servers] the statuses closed before {domain}'s consent was denied");
            return;
        }
    };
    let Some(consent_denier) = consent_denier else {
        log::error!("[servers] {domain}'s run reports no consent denier; its consent isn't denied");
        return;
    };
    match consent_denier
        .deny(request.pending_consent.key.clone())
        .await
    {
        Ok(()) => log::info!("[servers] denied a consent on {domain} from its notification"),
        Err(error) => log::warn!("[servers] a consent on {domain} wasn't denied: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wildflowerhealthio_authorization_server::domain::authorization_request::RequestStatus;
    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_servers::ServerConsentDenier;
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitStatus};

    use super::*;
    use crate::test_authorization_server::{
        test_authorization_server, TestAuthorizationServer, DOMAIN,
    };
    use crate::test_statuses::not_reporting;

    /// The request `id` on [`DOMAIN`], as a notification names it.
    fn request(id: &str) -> ConsentRequest {
        ConsentRequest {
            domain: DOMAIN.to_owned(),
            pending_consent: NewestPendingConsent::OAuth {
                id: id.to_owned(),
                client_name: "Lifting".to_owned(),
                decidable_in_requesting_browser: false,
            }
            .into(),
        }
    }

    /// The servers' statuses with [`DOMAIN`]'s run reporting, its denier
    /// over `authorization_server`.
    fn reporting(authorization_server: &TestAuthorizationServer) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
            health: None,
            tunnel: None,
            certificate: None,
            pending_consent: None,
            launch_minter: None,
            sign_in_code_minter: None,
            consent_watcher: None,
            consent_denier: Some(ServerConsentDenier::new(
                authorization_server.pending_consent_denier.clone(),
            )),
        };
        [(
            UnitId::new(DOMAIN),
            UnitStatus {
                run_state: RunState::Running,
                running_since: None,
                detail: Some(detail),
            },
        )]
        .into()
    }

    /// The servers' statuses with [`DOMAIN`]'s run not reporting.
    fn not_reporting_yet() -> UnitStatuses<ServerDetail> {
        [(UnitId::new(DOMAIN), not_reporting(RunState::Starting))].into()
    }

    #[tokio::test]
    async fn the_deny_denies_the_request_its_notification_named() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("a");
        let (_statuses_tx, statuses_rx) = watch::channel(reporting(&authorization_server));

        deny_consent_once_reporting(statuses_rx, &request("a")).await;

        assert_eq!(
            authorization_server.consent_status("a"),
            RequestStatus::Denied
        );
    }

    #[tokio::test]
    async fn the_deny_waits_for_the_run_to_report() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("a");
        let (statuses_tx, statuses_rx) = watch::channel(not_reporting_yet());
        let denying =
            tokio::spawn(
                async move { deny_consent_once_reporting(statuses_rx, &request("a")).await },
            );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            authorization_server.consent_status("a"),
            RequestStatus::Pending
        );

        statuses_tx.send(reporting(&authorization_server)).unwrap();
        tokio::time::timeout(Duration::from_secs(5), denying)
            .await
            .expect("it denies once the run reports")
            .unwrap();

        assert_eq!(
            authorization_server.consent_status("a"),
            RequestStatus::Denied
        );
    }

    #[tokio::test]
    async fn the_deny_leaves_a_request_already_approved_approved() {
        let authorization_server = test_authorization_server();
        authorization_server.park_decided_consent("a", RequestStatus::Approved);
        let (_statuses_tx, statuses_rx) = watch::channel(reporting(&authorization_server));

        deny_consent_once_reporting(statuses_rx, &request("a")).await;

        assert_eq!(
            authorization_server.consent_status("a"),
            RequestStatus::Approved
        );
    }

    #[tokio::test]
    async fn the_deny_denies_nothing_once_its_server_is_gone() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("a");
        let (statuses_tx, statuses_rx) = watch::channel(not_reporting_yet());
        let denying =
            tokio::spawn(
                async move { deny_consent_once_reporting(statuses_rx, &request("a")).await },
            );

        statuses_tx.send(UnitStatuses::default()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), denying)
            .await
            .expect("it ends")
            .unwrap();

        assert_eq!(
            authorization_server.consent_status("a"),
            RequestStatus::Pending
        );
    }
}
