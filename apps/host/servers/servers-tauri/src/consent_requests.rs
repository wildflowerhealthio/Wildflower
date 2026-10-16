//! Notifying each new consent waiting on the servers: a notification for each, "‹client› wants
//! access to ‹domain›", withdrawn once the request is no longer the server's newest, and opening
//! requests in the in-app browser, signed in as the Owner, as the server's page's Open does. On a
//! phone a tap on the notification opens its request, and the first fresh request a server reports
//! at the app's start opens instead of notifying, so a request whose notification launched the app
//! opens too; a return to the foreground opens a pending request the same way, so coming back to
//! the app after seeing a notification opens its request. On the desktop, which reports no taps,
//! each request opens in the default browser as it notifies. A request the Owner's own browser made
//! does neither. Which request notifies or opens is [`ConsentNotificationCoalescer`]'s decision.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{
    ConsentNotificationChanges, ConsentNotificationCoalescer, ConsentOpening, ConsentRequest,
    ServerDetail, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::{AppReturn, UnitStatuses};

use crate::notifications::{post_notification, withdraw_consent_notification};
use crate::pending_consent_badge::{PendingConsentBadge, ShownBadgeCount};
use crate::ServerUnits;

/// Which consent requests open on this platform: on a phone, a tap opens
/// one, and the first a server reports at the app's start; on the desktop,
/// which reports no taps, each that notifies.
const CONSENT_OPENING: ConsentOpening = if cfg!(any(target_os = "ios", target_os = "android")) {
    ConsentOpening::FirstAtStart
} else {
    ConsentOpening::AsNotified
};

/// Where a consent request is announced and opened: in the app, a posted
/// notification and the in-app browser; in the tests, a record of each.
pub(crate) trait ConsentRequestNotifier: Send + 'static {
    /// Announce `request`.
    fn notify(&self, request: &ConsentRequest);
    /// Withdraw the announcement of the server `domain`'s request.
    fn withdraw(&self, domain: &str);
    /// Open `request`.
    fn open(&self, request: &ConsentRequest);
}

/// The app's [`ConsentRequestNotifier`]: the notification plugin, and the
/// in-app browser (the default browser on the desktop), which opens a
/// request as the server's page's Open does.
pub(crate) struct AppConsentRequestNotifier {
    pub(crate) app: AppHandle,
    pub(crate) registry: Arc<dyn ServerRegistry>,
    /// The directory holding `servers.json` and each server's folder.
    pub(crate) data_root: PathBuf,
    pub(crate) server_units: ServerUnits,
    /// `TauriUnitRunner`'s statuses, which a request not openable yet is
    /// opened again on as they change.
    pub(crate) statuses_rx: watch::Receiver<UnitStatuses<ServerDetail>>,
}

impl ConsentRequestNotifier for AppConsentRequestNotifier {
    fn notify(&self, request: &ConsentRequest) {
        post_notification(&self.app, &request.notification());
    }

    fn withdraw(&self, domain: &str) {
        withdraw_consent_notification(&self.app, domain);
    }

    /// Open `request` signed in as the Owner, stacked over the views
    /// showing, as a tap on its notification does. A server that can't open
    /// it now, as one not yet launchable at the app's start, opens it once it
    /// can, while it is still the server's newest request; each try logs its
    /// outcome.
    fn open(&self, request: &ConsentRequest) {
        let registry = Arc::clone(&self.registry);
        let data_root = self.data_root.clone();
        let statuses_rx = self.statuses_rx.clone();
        let domain = request.domain.clone();
        let consent = request.pending_consent.key.clone();
        let launch_browser = crate::launch_commands::NativePageLaunchBrowser {
            app: self.app.clone(),
        };
        let server_units = self.server_units.clone();
        tauri::async_runtime::spawn(async move {
            crate::launch_commands::open_consent_once_openable(
                registry,
                &data_root,
                statuses_rx,
                domain,
                &consent,
                launch_browser,
                server_units,
            )
            .await;
        });
    }
}

/// Announce and open each consent request through `notifier`, every time
/// `TauriUnitRunner`'s statuses change or the app returns to the foreground
/// (`returns`), as [`ConsentNotificationCoalescer`] decides for
/// [`CONSENT_OPENING`].
pub(crate) async fn notify_consent_requests(
    notifier: impl ConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    returns: watch::Receiver<AppReturn<ServerDetail>>,
) {
    notify_and_open_consent_requests(notifier, statuses, returns, CONSENT_OPENING).await;
}

/// [`notify_consent_requests`], opening as `opening` says.
///
/// A return reaches the coalescer before the statuses read after it, so the
/// coalescer knows which runs the return found before it reads their
/// servers' next reports: a report counts as a resumed server's first since
/// the return only when a run other than the one the return found makes it.
async fn notify_and_open_consent_requests(
    notifier: impl ConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    mut returns: watch::Receiver<AppReturn<ServerDetail>>,
    opening: ConsentOpening,
) {
    let mut coalescer = ConsentNotificationCoalescer::new(opening);
    // A return `returns.changed()` woke the loop for, which marks it seen.
    let mut returned = false;
    loop {
        let Ok(returned_meanwhile) = returns.has_changed() else {
            log_returns_closed();
            return;
        };
        if std::mem::take(&mut returned) || returned_meanwhile {
            let app_return = returns.borrow_and_update().clone();
            apply(&notifier, &coalescer.returned_to_foreground(&app_return));
        }
        let current = statuses.borrow_and_update().clone();
        apply(&notifier, &coalescer.record(&current));
        tokio::select! {
            biased;
            changed = returns.changed() => {
                if changed.is_err() {
                    log_returns_closed();
                    return;
                }
                returned = true;
            }
            changed = statuses.changed() => {
                if changed.is_err() {
                    log::error!(
                        "[servers] the unit runner's statuses closed; consent notifications stopped"
                    );
                    return;
                }
            }
        }
    }
}

/// Log that the unit runner's returns to the foreground closed, which stops
/// the consent notifications.
fn log_returns_closed() {
    log::error!("[servers] the unit runner's returns closed; consent notifications stopped");
}

/// Withdraw, announce and open through `notifier` as `changes` says.
fn apply(notifier: &impl ConsentRequestNotifier, changes: &ConsentNotificationChanges) {
    for domain in &changes.withdrawn {
        notifier.withdraw(domain);
    }
    for request in &changes.posted {
        notifier.notify(request);
    }
    for request in &changes.opened {
        notifier.open(request);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use std::sync::OnceLock;
    use wildflowerhealthio_authorization_server::NewestPendingConsent;

    use wildflowerhealthio_servers::{ConsentKey, ServerRunId};
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;
    use crate::pending_consent_badge::tests::RecordedCounts;

    const RUTH: &str = "ruth.relay.example.com";

    /// The requests announced, the domains whose announcement was
    /// withdrawn, and the requests opened, each in order.
    #[derive(Clone, Default)]
    struct RecordedRequests(
        Arc<Mutex<Vec<ConsentRequest>>>,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<ConsentRequest>>>,
    );

    impl ConsentRequestNotifier for RecordedRequests {
        fn notify(&self, request: &ConsentRequest) {
            self.0.lock().unwrap().push(request.clone());
        }

        fn withdraw(&self, domain: &str) {
            self.1.lock().unwrap().push(domain.to_owned());
        }

        fn open(&self, request: &ConsentRequest) {
            self.2.lock().unwrap().push(request.clone());
        }
    }

    impl RecordedRequests {
        /// How many requests were announced.
        fn count(&self) -> usize {
            self.0.lock().unwrap().len()
        }

        /// The key of each request announced, in order.
        fn keys(&self) -> Vec<ConsentKey> {
            keys_of(&self.0)
        }

        /// The key of each request opened, in order.
        fn opened_keys(&self) -> Vec<ConsentKey> {
            keys_of(&self.2)
        }
    }

    fn keys_of(requests: &Mutex<Vec<ConsentRequest>>) -> Vec<ConsentKey> {
        requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.pending_consent.key.clone())
            .collect()
    }

    /// The servers' statuses with [`RUTH`] running, the request `newest`
    /// the newest waiting there, if any, the same run each time.
    fn ruth_waiting_on(newest: Option<&str>) -> UnitStatuses<ServerDetail> {
        static THE_RUN: OnceLock<ServerRunId> = OnceLock::new();
        ruth_reporting(*THE_RUN.get_or_init(ServerRunId::next), newest)
    }

    /// The servers' statuses with [`RUTH`]'s run `run` reporting, the request
    /// `newest` the newest waiting there, if any.
    fn ruth_reporting(run: ServerRunId, newest: Option<&str>) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
            run,
            health: None,
            tunnel: None,
            certificate: None,
            pending_consent: newest.map(|id| NewestPendingConsent::OAuth {
                id: id.to_owned(),
                client_name: "Lifting".to_owned(),
                requested_by_owner_browser: false,
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

    /// The servers' statuses with [`RUTH`]'s run stopped.
    fn ruth_stopped() -> UnitStatuses<ServerDetail> {
        [(UnitId::new(RUTH), UnitStatus::never_run())].into()
    }

    /// Send `statuses`, the servers' or a return's, then yield to the
    /// notifier, on the test's one thread, until it is waiting for the next
    /// change again.
    async fn send_and_let_it_read<T>(statuses_tx: &watch::Sender<T>, statuses: T) {
        statuses_tx.send(statuses).unwrap();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn each_new_request_is_announced_once_and_one_seen_before_is_not() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (_returns_tx, returns_rx) = watch::channel(AppReturn::default());
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            returns_rx,
            ConsentOpening::AsNotified,
        ));
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
        assert_eq!(recorded.opened_keys(), [oauth("a"), oauth("b")]);
        assert_eq!(
            recorded.0.lock().unwrap()[1].notification().body,
            format!("Lifting wants access to {RUTH}")
        );
    }

    #[tokio::test]
    async fn on_a_phone_the_request_waiting_at_start_opens_and_a_later_one_notifies() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (_returns_tx, returns_rx) = watch::channel(AppReturn::default());
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            returns_rx,
            ConsentOpening::FirstAtStart,
        ));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(recorded.opened_keys(), [oauth("a")]);
        assert!(recorded.keys().is_empty());

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.keys(), [oauth("b")]);
        assert_eq!(recorded.opened_keys(), [oauth("a")]);
    }

    #[tokio::test]
    async fn on_a_phone_each_return_opens_the_announced_request_once_its_server_reports_it() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (returns_tx, returns_rx) = watch::channel(AppReturn::default());
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            returns_rx,
            ConsentOpening::FirstAtStart,
        ));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(recorded.keys(), [oauth("a")]);
        assert!(
            recorded.opened_keys().is_empty(),
            "a later request notifies"
        );

        // Back with the server still running: "a" opens now.
        let carried_on = AppReturn {
            carried_on: ruth_waiting_on(Some("a")),
            resumed: UnitStatuses::new(),
        };
        send_and_let_it_read(&returns_tx, carried_on).await;
        assert_eq!(recorded.opened_keys(), [oauth("a")]);

        // Back with the server's run asked to restart, as on iOS: its old run
        // still reports "a" until it stops, then the new run reports it.
        let restarted = AppReturn {
            carried_on: UnitStatuses::new(),
            resumed: ruth_waiting_on(Some("a")),
        };
        send_and_let_it_read(&returns_tx, restarted).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(
            recorded.opened_keys(),
            [oauth("a")],
            "the old run's report isn't the new run's first"
        );
        send_and_let_it_read(&statuses_tx, ruth_stopped()).await;
        send_and_let_it_read(&statuses_tx, ruth_reporting(ServerRunId::next(), Some("a"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.opened_keys(), [oauth("a"), oauth("a")]);
        assert_eq!(recorded.keys(), [oauth("a")], "it notified once");
    }

    #[tokio::test]
    async fn the_returns_closing_stops_the_notifications() {
        let (_statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (returns_tx, returns_rx) = watch::channel(AppReturn::default());
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            RecordedRequests::default(),
            statuses_rx,
            returns_rx,
            ConsentOpening::FirstAtStart,
        ));

        drop(returns_tx);

        tokio::time::timeout(std::time::Duration::from_secs(5), notifying)
            .await
            .expect("it stops")
            .unwrap();
    }
}
