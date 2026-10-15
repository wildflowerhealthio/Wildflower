//! Notifying each new consent waiting on the servers: a notification for
//! each, "‹client› wants access to ‹domain›", withdrawn once the request is
//! no longer the server's newest. A tap opens it on a phone; a desktop, which
//! reports no taps, opens it from the server's page.

use tauri::AppHandle;
use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{ConsentNotificationCoalescer, ConsentRequest, ServerDetail};
use wildflowerhealthio_tauri_unit_runner::UnitStatuses;

use crate::notifications::{post_notification, withdraw_consent_notification};

/// Where a consent request is announced: in the app, a posted notification;
/// in the tests, a record of the requests announced.
pub(crate) trait ConsentRequestNotifier: Send + 'static {
    /// Announce `request`.
    fn notify(&self, request: &ConsentRequest);
    /// Withdraw the announcement of the server `domain`'s request.
    fn withdraw(&self, domain: &str);
}

/// The app's [`ConsentRequestNotifier`]: the notification plugin.
pub(crate) struct AppConsentRequestNotifier {
    pub(crate) app: AppHandle,
}

impl ConsentRequestNotifier for AppConsentRequestNotifier {
    fn notify(&self, request: &ConsentRequest) {
        post_notification(&self.app, &request.notification());
    }

    fn withdraw(&self, domain: &str) {
        withdraw_consent_notification(&self.app, domain);
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
        let changes = coalescer.record(&current);
        for domain in &changes.withdrawn {
            notifier.withdraw(domain);
        }
        for request in &changes.posted {
            notifier.notify(request);
        }
        if statuses.changed().await.is_err() {
            log::error!(
                "[servers] the unit runner's statuses closed; consent notifications stopped"
            );
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_servers::ConsentKey;
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;

    const RUTH: &str = "ruth.relay.example.com";

    /// The requests announced, and the domains whose announcement was
    /// withdrawn, each in order.
    #[derive(Clone, Default)]
    struct RecordedRequests(Arc<Mutex<Vec<ConsentRequest>>>, Arc<Mutex<Vec<String>>>);

    impl ConsentRequestNotifier for RecordedRequests {
        fn notify(&self, request: &ConsentRequest) {
            self.0.lock().unwrap().push(request.clone());
        }

        fn withdraw(&self, domain: &str) {
            self.1.lock().unwrap().push(domain.to_owned());
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
        // announced already, and "b"'s announcement is withdrawn.
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(recorded.count(), 2);
        assert_eq!(*recorded.1.lock().unwrap(), [RUTH]);
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.keys(), [oauth("a"), oauth("b")]);
        assert_eq!(
            recorded.0.lock().unwrap()[1].notification().body,
            format!("Lifting wants access to {RUTH}")
        );
    }
}
