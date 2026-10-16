//! Notifying each new consent waiting on the servers: a notification for each, "‹client› wants
//! access to ‹domain›", withdrawn once the request is no longer the server's newest, and opening
//! requests in the in-app browser, signed in as the Owner, as the server's page's Open does. On a
//! phone a tap on the notification opens its request, and each arrival of the app in the foreground
//! opens one: the request notified latest that is still its server's newest, so coming back to the
//! app after seeing a notification opens its request, or failing one, the first request a server on
//! its way up reports, so a request whose notification launched the app opens too, instead of
//! notifying. On the desktop, which reports no taps, each request opens in the default browser as
//! it notifies. A request the Owner's own browser made does neither. Which request notifies or opens is [`ConsentNotificationCoalescer`]'s decision.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::AppHandle;
use tauri_plugin_log::log;
use tokio::sync::{oneshot, watch};
use wildflowerhealthio_servers::{
    ConsentNotificationChanges, ConsentNotificationCoalescer, ConsentOpening, ConsentRequest,
    ServerDetail, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::{TauriUnitRunner, UnitId, UnitStatuses};

use crate::notifications::{post_notification, withdraw_consent_notification};
use crate::pending_consent_badge::{PendingConsentBadge, ShownBadgeCount};
use crate::ServerUnits;

/// Which consent requests open on this platform: on a phone, a tap opens
/// one, and each arrival of the app in the foreground; on the desktop, which
/// reports no taps, each that notifies.
const CONSENT_OPENING: ConsentOpening = if cfg!(any(target_os = "ios", target_os = "android")) {
    ConsentOpening::OnArrival
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
    /// For each server, by domain, what ends the wait of its latest open
    /// once dropped, which a later open for the server does as it takes the
    /// place: each server has at most one open waiting, however many opens
    /// a server that doesn't run, as one whose policy is off, gets.
    pub(crate) latest_opens: Mutex<HashMap<String, oneshot::Sender<()>>>,
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
    /// it now, as one not yet launchable at the app's start or whose run is
    /// stopping or starting, opens it once it can, while it is still the
    /// server's newest request; each try logs its outcome. A later open for
    /// the same server ends this one's wait.
    fn open(&self, request: &ConsentRequest) {
        let registry = Arc::clone(&self.registry);
        let data_root = self.data_root.clone();
        let statuses_rx = self.statuses_rx.clone();
        let launch_browser = crate::launch_commands::NativePageLaunchBrowser {
            app: self.app.clone(),
        };
        let server_units = self.server_units.clone();
        let request = request.clone();
        let (take_over, taken_over) = oneshot::channel();
        // Replacing the earlier open's sender drops it, which ends its wait.
        self.latest_opens
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(request.domain.clone(), take_over);
        tauri::async_runtime::spawn(async move {
            crate::launch_commands::open_consent_once_openable(
                registry,
                &data_root,
                statuses_rx,
                &request,
                launch_browser,
                server_units,
                async {
                    // Dropped, or sent nothing ever.
                    let _taken_over = taken_over.await;
                },
            )
            .await;
        });
    }
}

/// Announce and open each consent request through `notifier`, every time
/// `runner`'s statuses change or the app arrives in the foreground, as
/// [`ConsentNotificationCoalescer`] decides for [`CONSENT_OPENING`].
pub(crate) async fn notify_consent_requests(
    notifier: impl ConsentRequestNotifier,
    runner: TauriUnitRunner<ServerDetail>,
) {
    let statuses = runner.subscribe();
    let arrivals = runner.subscribe_foreground_arrivals();
    notify_and_open_consent_requests(
        notifier,
        statuses,
        arrivals,
        move || runner.units_to_run(),
        CONSENT_OPENING,
    )
    .await;
}

/// [`notify_consent_requests`] with the servers' `statuses`, the app's
/// `arrivals` in the foreground, and the servers the unit runner runs now
/// (`units_to_run`), opening as `opening` says.
///
/// An arrival before this starts, as the first window's, which opens before
/// the host sets the servers on the unit runner, counts as one as it starts,
/// so a request a server reports as the app starts in the foreground opens.
async fn notify_and_open_consent_requests(
    notifier: impl ConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    mut arrivals: watch::Receiver<u64>,
    units_to_run: impl Fn() -> BTreeSet<UnitId>,
    opening: ConsentOpening,
) {
    let mut coalescer = ConsentNotificationCoalescer::new(opening);
    let arrived_before = *arrivals.borrow_and_update() > 0;
    let current = statuses.borrow_and_update().clone();
    if arrived_before {
        apply(
            &notifier,
            &coalescer.came_to_foreground(&current, &units_to_run()),
        );
    } else {
        apply(&notifier, &coalescer.record(&current));
    }
    loop {
        tokio::select! {
            changed = arrivals.changed() => {
                if changed.is_err() {
                    log::error!(
                        "[servers] the unit runner's foreground arrivals closed; consent \
                         notifications stopped"
                    );
                    return;
                }
                let current = statuses.borrow_and_update().clone();
                apply(&notifier, &coalescer.came_to_foreground(&current, &units_to_run()));
            }
            changed = statuses.changed() => {
                if changed.is_err() {
                    log::error!(
                        "[servers] the unit runner's statuses closed; consent notifications stopped"
                    );
                    return;
                }
                let current = statuses.borrow_and_update().clone();
                apply(&notifier, &coalescer.record(&current));
            }
        }
    }
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

    use wildflowerhealthio_authorization_server::NewestPendingConsent;

    use wildflowerhealthio_servers::ConsentKey;
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
    /// the newest waiting there, if any.
    fn ruth_waiting_on(newest: Option<&str>) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
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

    /// The servers' statuses with [`RUTH`]'s run running and reporting
    /// nothing, as while it starts, or stops for the restart a return brings
    /// on iOS.
    fn ruth_not_reporting() -> UnitStatuses<ServerDetail> {
        let status = UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: None,
        };
        [(UnitId::new(RUTH), status)].into()
    }

    /// Yield to the notifier, on the test's one thread, until it is waiting
    /// for the next change again.
    async fn let_it_read() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    /// Send `statuses`, then let the notifier read them.
    async fn send_and_let_it_read(
        statuses_tx: &watch::Sender<UnitStatuses<ServerDetail>>,
        statuses: UnitStatuses<ServerDetail>,
    ) {
        statuses_tx.send(statuses).unwrap();
        let_it_read().await;
    }

    /// Return to the foreground, then let the notifier read it.
    async fn return_and_let_it_read(arrivals_tx: &watch::Sender<u64>) {
        arrivals_tx.send_modify(|arrivals| *arrivals += 1);
        let_it_read().await;
    }

    /// The servers the unit runner runs: [`RUTH`].
    fn ruth_to_run() -> BTreeSet<UnitId> {
        [UnitId::new(RUTH)].into()
    }

    #[tokio::test]
    async fn each_new_request_is_announced_once_and_one_seen_before_is_not() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (_arrivals_tx, arrivals_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            arrivals_rx,
            ruth_to_run,
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
        // The first window opened before the notifications started.
        let (_arrivals_tx, arrivals_rx) = watch::channel(1);
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            arrivals_rx,
            ruth_to_run,
            ConsentOpening::OnArrival,
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
    async fn on_a_phone_the_first_request_a_server_starting_at_start_reports_opens() {
        let (statuses_tx, statuses_rx) =
            watch::channel([(UnitId::new(RUTH), UnitStatus::never_run())].into());
        // The first window opened before the notifications started.
        let (_arrivals_tx, arrivals_rx) = watch::channel(1);
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            arrivals_rx,
            ruth_to_run,
            ConsentOpening::OnArrival,
        ));
        let_it_read().await;

        send_and_let_it_read(&statuses_tx, ruth_not_reporting()).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.opened_keys(), [oauth("a")]);
        assert_eq!(recorded.keys(), [oauth("b")], "a later request notifies");
    }

    #[tokio::test]
    async fn on_a_phone_each_return_opens_the_announced_request() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (arrivals_tx, arrivals_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            arrivals_rx,
            ruth_to_run,
            ConsentOpening::OnArrival,
        ));
        let_it_read().await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(recorded.keys(), [oauth("a")]);
        assert!(
            recorded.opened_keys().is_empty(),
            "a later request notifies"
        );

        // Back with the server's run carrying on: "a" opens.
        return_and_let_it_read(&arrivals_tx).await;
        assert_eq!(recorded.opened_keys(), [oauth("a")]);

        // Back with the server's run asked to stop for a restart, as on iOS:
        // "a" opens again, its open waiting for the new run to report it.
        send_and_let_it_read(&statuses_tx, ruth_not_reporting()).await;
        return_and_let_it_read(&arrivals_tx).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.opened_keys(), [oauth("a"), oauth("a")]);
        assert_eq!(recorded.keys(), [oauth("a")], "it notified once");
    }

    #[tokio::test]
    async fn the_arrivals_closing_stops_the_notifications() {
        let (_statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (arrivals_tx, arrivals_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            RecordedRequests::default(),
            statuses_rx,
            arrivals_rx,
            ruth_to_run,
            ConsentOpening::OnArrival,
        ));

        drop(arrivals_tx);

        tokio::time::timeout(std::time::Duration::from_secs(5), notifying)
            .await
            .expect("it stops")
            .unwrap();
    }
}
