//! Notifying each new consent waiting on the servers: a
//! notification for each, "‹client› wants access to ‹domain›", and on the
//! desktop the base's window brought forward, so the server's page, where its
//! pending request opens, can be reached at once.

use tauri::{AppHandle, Runtime};
use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{ConsentNotificationCoalescer, ConsentRequest, ServerDetail};
use wildflowerhealthio_tauri_unit_runner::UnitStatuses;

use crate::notifications::post_notification;
use crate::BASE_WEBVIEW_LABEL;

/// Where a consent request is announced: in the app, a posted notification
/// and the desktop window brought forward; in the tests, a record of the
/// requests announced.
pub(crate) trait ConsentRequestNotifier: Send + 'static {
    /// Announce `request`.
    fn notify(&self, request: &ConsentRequest);
}

/// The app's [`ConsentRequestNotifier`]: the notification plugin, and the
/// base's window.
pub(crate) struct AppConsentRequestNotifier<R: Runtime> {
    pub(crate) app: AppHandle<R>,
}

impl<R: Runtime> ConsentRequestNotifier for AppConsentRequestNotifier<R> {
    fn notify(&self, request: &ConsentRequest) {
        post_notification(&self.app, &request.notification());
        raise_main_window(&self.app);
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

/// Bring the base's window to the front, so the server's page, whose pending
/// request opens the consent, is a click away: an app on another device, or
/// one launched from the base, is waiting on it. A minimised window is
/// restored first.
///
/// Desktop only: iOS doesn't let an app take the foreground, and Android
/// surfaces the app differently; there a tap on the notification opens the
/// consent. (`cfg(desktop)` is set only for the app crate, by `tauri-build`,
/// so this gate names the mobile targets.)
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn raise_main_window<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window(BASE_WEBVIEW_LABEL) else {
        log::warn!("[servers] no '{BASE_WEBVIEW_LABEL}' window to bring forward for a consent");
        return;
    };
    if matches!(window.is_minimized(), Ok(true)) {
        if let Err(error) = window.unminimize() {
            log::warn!("[servers] restoring the window for a consent failed: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[servers] focusing the window for a consent failed: {error}");
    }
}

/// Mobile builds leave the window where it is: see the desktop variant.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn raise_main_window<R: Runtime>(_app: &AppHandle<R>) {}

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
