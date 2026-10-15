//! Notifying each new consent waiting on the servers: a notification for
//! each, "‹client› wants access to ‹domain›", and on the desktop the request
//! opened at once in the default browser, since a desktop can't click the
//! notification.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{
    ConsentNotificationCoalescer, ConsentRequest, ServerDetail, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::UnitStatuses;

use crate::notifications::post_notification;
use crate::ServerUnits;

/// Where a consent request is announced: in the app, a posted notification
/// and, on the desktop, the request opened; in the tests, a record of the
/// requests announced.
pub(crate) trait ConsentRequestNotifier: Send + 'static {
    /// Announce `request`.
    fn notify(&self, request: &ConsentRequest);
}

/// The app's [`ConsentRequestNotifier`]: the notification plugin, and on the
/// desktop the default browser, which opens the request as the server's
/// page's Open does.
pub(crate) struct AppConsentRequestNotifier {
    pub(crate) app: AppHandle,
    pub(crate) registry: Arc<dyn ServerRegistry>,
    /// The directory holding `servers.json` and each server's folder.
    pub(crate) data_root: PathBuf,
    pub(crate) server_units: ServerUnits,
    /// `TauriUnitRunner`'s statuses, which a request not openable yet on the
    /// desktop is opened again on as they change.
    pub(crate) statuses_rx: watch::Receiver<UnitStatuses<ServerDetail>>,
}

impl ConsentRequestNotifier for AppConsentRequestNotifier {
    fn notify(&self, request: &ConsentRequest) {
        post_notification(&self.app, &request.notification());
        open_on_desktop(self, request);
    }
}

/// Announce each consent request through `notifier`, every time
/// `TauriUnitRunner`'s statuses change, as [`ConsentNotificationCoalescer`]
/// decides: once per request, when it is a server's newest waiting and the
/// server hasn't notified for it.
pub(crate) async fn notify_consent_requests(
    notifier: impl ConsentRequestNotifier,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
) {
    let mut coalescer = ConsentNotificationCoalescer::new();
    loop {
        let current = statuses.borrow_and_update().clone();
        for request in coalescer.record(&current) {
            notifier.notify(&request);
        }
        if statuses.changed().await.is_err() {
            log::error!(
                "[servers] the unit runner's statuses closed; consent notifications stopped"
            );
            return;
        }
    }
}

/// Open `request` in the default browser, signed in as the Owner, as the
/// server's page's Open does: a desktop can't click a notification
/// (`tauri-plugin-notification` reports no taps there), so the request opens
/// as it notifies. A server that can't open it now, as one not yet launchable
/// at the app's start, opens it once it can, while it is still the server's
/// newest request; each try logs its outcome.
///
/// Desktop only: on a phone a tap on the notification opens the request.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn open_on_desktop(notifier: &AppConsentRequestNotifier, request: &ConsentRequest) {
    tauri::async_runtime::spawn(crate::launch_commands::open_notified_consent_on_desktop(
        notifier.app.clone(),
        Arc::clone(&notifier.registry),
        notifier.data_root.clone(),
        notifier.server_units.clone(),
        request.domain.clone(),
        request.pending_consent.key.clone(),
        notifier.statuses_rx.clone(),
    ));
}

/// Mobile builds open nothing: see the desktop variant.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn open_on_desktop(_notifier: &AppConsentRequestNotifier, _request: &ConsentRequest) {}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_servers::ConsentKey;
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;

    const RUTH: &str = "ruth.relay.example.com";

    /// The requests announced, in order.
    #[derive(Clone, Default)]
    struct RecordedRequests(Arc<Mutex<Vec<ConsentRequest>>>);

    impl ConsentRequestNotifier for RecordedRequests {
        fn notify(&self, request: &ConsentRequest) {
            self.0.lock().unwrap().push(request.clone());
        }
    }

    impl RecordedRequests {
        /// How many requests were announced.
        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }

        /// The key of each request announced, in order.
        fn keys(&self) -> Vec<ConsentKey> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|request| request.pending_consent.key.clone())
                .collect()
        }
    }

    /// The servers' statuses with [`RUTH`] running, the request `newest`
    /// the newest waiting there, if any.
    fn ruth_waiting_on(newest: Option<&str>) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
            health: None,
            tunnel: None,
            certificate: None,
            pending_consent: newest.map(|id| NewestPendingConsent::OAuth {
                id: id.to_owned(),
                client_name: "Lifting".to_owned(),
            }),
            launch_minter: None,
            sign_in_code_minter: None,
            consent_watcher: None,
        };
        [(
            UnitId::new(RUTH),
            UnitStatus {
                run_state: RunState::Running,
                running_since: None,
                detail: Some(detail),
            },
        )]
        .into()
    }

    fn oauth(id: &str) -> ConsentKey {
        ConsentKey::OAuth { id: id.to_owned() }
    }

    /// Send `statuses`, then yield to the notifier, on the test's one
    /// thread, until it is waiting for the next change again.
    async fn send_and_let_it_read(
        statuses_tx: &watch::Sender<UnitStatuses<ServerDetail>>,
        statuses: UnitStatuses<ServerDetail>,
    ) {
        statuses_tx.send(statuses).unwrap();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn each_new_request_is_announced_once_and_one_seen_before_is_not() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_consent_requests(recorded.clone(), statuses_rx));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(recorded.keys(), [oauth("a")]);

        // A newer request arrives, and is decided: "a" comes back, but was
        // announced already.
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(recorded.count(), 2);
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.keys(), [oauth("a"), oauth("b")]);
        assert_eq!(
            recorded.0.lock().unwrap()[1].notification().body,
            format!("Lifting wants access to {RUTH}")
        );
    }
}
