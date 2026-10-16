//! Notifying each new consent waiting on the servers: a notification for each, "‹client› wants
//! access to ‹domain›", withdrawn once the request is no longer the server's newest, and opening
//! requests in the in-app browser, signed in as the Owner, as the server's page's Open does. On a
//! phone a tap on the notification opens its request, and each arrival of the app in the foreground
//! opens one: the request notified latest that is still its server's newest, so coming back to the
//! app after seeing a notification opens its request, or failing one, the first request a server on
//! its way up reports, so a request whose notification launched the app opens too, instead of
//! notifying. A tap wins over the arrival it brings: on Android that arrival opens nothing, and
//! everywhere the tap ends the arrival's wait for a first report and every open still waiting for
//! its server. Leaving the foreground ends them too, since nothing opens there. On the desktop,
//! which reports no taps, each request opens in the default browser as it notifies. A request the
//! Owner's own browser made does neither. Which request notifies or opens is
//! [`ConsentNotificationCoalescer`]'s decision.

use std::collections::BTreeSet;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_page_browser::NativePageBrowserExt;
use tokio::sync::watch;
use wildflowerhealthio_servers::{
    ConsentNotificationChanges, ConsentNotificationCoalescer, ConsentOpening, ConsentRequest,
    ServerDetail, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::{
    ForegroundArrivals, TauriUnitRunner, UnitId, UnitStatuses,
};

use crate::launch_commands::ConsentToOpen;
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
    /// End the wait of every open still waiting for its server.
    fn end_waiting_opens(&self);
    /// Whether the app's latest arrival in the foreground came to open a page
    /// of its own, as a tap on a consent notification does on Android, whose
    /// consent the tap opens; forgets it.
    fn take_arrival_opening_its_own_page(&self) -> impl Future<Output = bool> + Send;
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
    /// it now, as one not yet launchable at the app's start or whose run is
    /// stopping or starting, opens it once it can, while it is still the
    /// server's newest request; each try logs its outcome. A later open for
    /// the same server ends this one's wait
    /// ([`WaitingConsentOpens`](crate::waiting_consent_opens::WaitingConsentOpens)).
    fn open(&self, request: &ConsentRequest) {
        let registry = Arc::clone(&self.registry);
        let data_root = self.data_root.clone();
        let statuses_rx = self.statuses_rx.clone();
        let launch_browser = crate::launch_commands::NativePageLaunchBrowser {
            app: self.app.clone(),
        };
        let server_units = self.server_units.clone();
        let superseded = server_units
            .waiting_consent_opens()
            .wait_for(&request.domain);
        let consent = ConsentToOpen::Request(request.clone());
        tauri::async_runtime::spawn(async move {
            crate::launch_commands::open_consent_once_openable(
                registry,
                &data_root,
                statuses_rx,
                &consent,
                launch_browser,
                server_units,
                superseded,
            )
            .await;
        });
    }

    fn end_waiting_opens(&self) {
        self.server_units.waiting_consent_opens().end_all();
    }

    /// As the in-app browser plugin says the host's activity marked it
    /// (Android); a failure to ask is logged, and counts as no.
    fn take_arrival_opening_its_own_page(&self) -> impl Future<Output = bool> + Send {
        let app = self.app.clone();
        async move {
            app.native_page_browser()
                .take_resume_opening_its_own_page()
                .await
                .unwrap_or_else(|error| {
                    log::warn!(
                        "[servers] asking whether the app came back to open a page of its own \
                         failed: {error}"
                    );
                    false
                })
        }
    }
}

/// Announce and open each consent request through `notifier`, every time
/// `runner`'s statuses change, the app arrives in or leaves the foreground,
/// or a consent notification is tapped, as [`ConsentNotificationCoalescer`]
/// decides for [`CONSENT_OPENING`].
pub(crate) async fn notify_consent_requests(
    notifier: AppConsentRequestNotifier,
    runner: TauriUnitRunner<ServerDetail>,
) {
    let statuses = runner.subscribe();
    let arrivals = runner.subscribe_foreground_arrivals();
    let taps = notifier.server_units.subscribe_notification_taps();
    notify_and_open_consent_requests(
        notifier,
        statuses,
        arrivals,
        taps,
        move || runner.units_to_run(),
        CONSENT_OPENING,
    )
    .await;
}

/// [`notify_consent_requests`] with the servers' `statuses`, the app's
/// `arrivals` in the foreground, the `taps` on consent notifications, and the
/// servers the unit runner runs now (`units_to_run`), opening as `opening`
/// says.
///
/// An arrival before this starts, as the first window's, which opens before
/// the host sets the servers on the unit runner, counts as one as it starts,
/// while the app is still in the foreground, so a request a server reports as
/// the app starts in the foreground opens. An arrival that came to open a
/// page of its own ([`ConsentRequestNotifier::take_arrival_opening_its_own_page`])
/// opens nothing, and nor does one under [`ConsentOpening::AsNotified`]. When
/// the app leaves the foreground, and when a notification is tapped, the
/// arrival's wait for a first report ends; leaving under
/// [`ConsentOpening::OnArrival`] ends every open still waiting for its server
/// too, as none can open in the background. When an arrival and a change of
/// the statuses are both ready, the arrival goes first: it reads the statuses
/// itself.
async fn notify_and_open_consent_requests(
    notifier: impl ConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    mut arrivals: watch::Receiver<ForegroundArrivals>,
    mut taps: watch::Receiver<u64>,
    units_to_run: impl Fn() -> BTreeSet<UnitId>,
    opening: ConsentOpening,
) {
    let mut coalescer = ConsentNotificationCoalescer::new(opening);
    let foreground = *arrivals.borrow_and_update();
    taps.borrow_and_update();
    let mut seen_arrivals = foreground.arrivals;
    if foreground.arrivals > 0 && foreground.in_foreground {
        arrive(&notifier, &mut coalescer, &mut statuses, &units_to_run).await;
    } else {
        let current = statuses.borrow_and_update().clone();
        apply(&notifier, &coalescer.record(&current));
    }
    loop {
        tokio::select! {
            // An arrival first: it reads the statuses itself.
            biased;
            changed = arrivals.changed() => {
                if changed.is_err() {
                    log::error!(
                        "[servers] the unit runner's foreground arrivals closed; consent \
                         notifications stopped"
                    );
                    return;
                }
                let foreground = *arrivals.borrow_and_update();
                let arrived = std::mem::replace(&mut seen_arrivals, foreground.arrivals)
                    != foreground.arrivals;
                if !foreground.in_foreground {
                    coalescer.end_arrival_wait();
                    if opening == ConsentOpening::OnArrival {
                        notifier.end_waiting_opens();
                    }
                } else if arrived {
                    arrive(&notifier, &mut coalescer, &mut statuses, &units_to_run).await;
                }
            }
            changed = taps.changed() => {
                if changed.is_err() {
                    log::error!(
                        "[servers] the consent notification taps closed; consent notifications \
                         stopped"
                    );
                    return;
                }
                taps.borrow_and_update();
                coalescer.end_arrival_wait();
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

/// The app arrived in the foreground: record the servers' `statuses` with
/// `coalescer`, which opens at most one request for the arrival, unless the
/// arrival came to open a page of its own, which ends the arrival's wait
/// instead; then withdraw, announce and open through `notifier` as it says.
async fn arrive(
    notifier: &impl ConsentRequestNotifier,
    coalescer: &mut ConsentNotificationCoalescer,
    statuses: &mut watch::Receiver<UnitStatuses<ServerDetail>>,
    units_to_run: &impl Fn() -> BTreeSet<UnitId>,
) {
    let opens_its_own_page = notifier.take_arrival_opening_its_own_page().await;
    let current = statuses.borrow_and_update().clone();
    let changes = if opens_its_own_page {
        coalescer.end_arrival_wait();
        coalescer.record(&current)
    } else {
        coalescer.came_to_foreground(&current, &units_to_run())
    };
    apply(notifier, &changes);
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use wildflowerhealthio_authorization_server::NewestPendingConsent;

    use wildflowerhealthio_servers::ConsentKey;
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;
    use crate::test_statuses::not_reporting;

    const RUTH: &str = "ruth.relay.example.com";

    /// The requests announced, the domains whose announcement was
    /// withdrawn, and the requests opened, each in order; how many times the
    /// waiting opens' waits were ended; and whether the next arrival comes to
    /// open a page of its own, as one a tap brings on Android.
    #[derive(Clone, Default)]
    struct RecordedRequests(
        Arc<Mutex<Vec<ConsentRequest>>>,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<ConsentRequest>>>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
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

        fn end_waiting_opens(&self) {
            self.3.fetch_add(1, Ordering::SeqCst);
        }

        fn take_arrival_opening_its_own_page(&self) -> impl Future<Output = bool> + Send {
            let opens_its_own_page = self.4.swap(false, Ordering::SeqCst);
            async move { opens_its_own_page }
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
        [(UnitId::new(RUTH), not_reporting(RunState::Running))].into()
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
    async fn return_and_let_it_read(arrivals_tx: &watch::Sender<ForegroundArrivals>) {
        arrive_in_the_foreground(arrivals_tx);
        let_it_read().await;
    }

    /// Arrive in the foreground.
    fn arrive_in_the_foreground(arrivals_tx: &watch::Sender<ForegroundArrivals>) {
        arrivals_tx.send_modify(|foreground| {
            foreground.arrivals += 1;
            foreground.in_foreground = true;
        });
    }

    /// The app's arrivals in the foreground: `arrivals` of them, the app in
    /// the foreground since the last if there was one.
    fn arrived(arrivals: u64) -> ForegroundArrivals {
        ForegroundArrivals {
            arrivals,
            in_foreground: arrivals > 0,
        }
    }

    /// The servers the unit runner runs: [`RUTH`].
    fn ruth_to_run() -> BTreeSet<UnitId> {
        [UnitId::new(RUTH)].into()
    }

    #[tokio::test]
    async fn each_new_request_is_announced_once_and_one_seen_before_is_not() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let recorded = RecordedRequests::default();
        let (_taps_tx, taps_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
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
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(1));
        let recorded = RecordedRequests::default();
        let (_taps_tx, taps_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
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
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(1));
        let recorded = RecordedRequests::default();
        let (_taps_tx, taps_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
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
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let recorded = RecordedRequests::default();
        let (_taps_tx, taps_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
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

    /// On a phone, notify and open through `recorded` from the statuses
    /// `statuses_rx` holds and the arrivals `arrivals_rx` holds, with the
    /// taps `taps_rx` holds, the unit runner running [`RUTH`].
    fn notify_on_a_phone(
        recorded: &RecordedRequests,
        statuses_rx: watch::Receiver<UnitStatuses<ServerDetail>>,
        arrivals_rx: watch::Receiver<ForegroundArrivals>,
        taps_rx: watch::Receiver<u64>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
            ruth_to_run,
            ConsentOpening::OnArrival,
        ))
    }

    #[tokio::test]
    async fn on_a_phone_leaving_the_foreground_ends_the_arrival_s_wait_and_every_waiting_open() {
        let (statuses_tx, statuses_rx) =
            watch::channel([(UnitId::new(RUTH), UnitStatus::never_run())].into());
        // RUTH is on its way up as the app starts in the foreground.
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(1));
        let (_taps_tx, taps_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        arrivals_tx.send_modify(|foreground| foreground.in_foreground = false);
        let_it_read().await;
        assert_eq!(recorded.3.load(Ordering::SeqCst), 1);
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.keys(), [oauth("a")], "it notifies");
        assert!(recorded.opened_keys().is_empty());
    }

    #[tokio::test]
    async fn on_a_phone_a_tap_ends_the_arrival_s_wait() {
        let (statuses_tx, statuses_rx) =
            watch::channel([(UnitId::new(RUTH), UnitStatus::never_run())].into());
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(1));
        let (taps_tx, taps_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        // The tap opens its own consent, as `server_open_notified_consent`
        // does.
        taps_tx.send_modify(|taps| *taps += 1);
        let_it_read().await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.keys(), [oauth("a")], "it notifies");
        assert!(recorded.opened_keys().is_empty());
    }

    #[tokio::test]
    async fn on_android_an_arrival_a_tap_brings_opens_nothing() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;
        assert_eq!(recorded.keys(), [oauth("a")]);

        // The host's activity marks the resume the tap on "a" brings.
        recorded.4.store(true, Ordering::SeqCst);
        return_and_let_it_read(&arrivals_tx).await;
        assert!(recorded.opened_keys().is_empty(), "the tap opens it");
        return_and_let_it_read(&arrivals_tx).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(
            recorded.opened_keys(),
            [oauth("a")],
            "the next arrival opens as usual"
        );
    }

    #[tokio::test]
    async fn on_a_phone_an_arrival_goes_before_a_status_change_ready_with_it() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(0);
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        // "a" lands as the app returns, before the notifier reads either.
        statuses_tx.send(ruth_waiting_on(Some("a"))).unwrap();
        arrive_in_the_foreground(&arrivals_tx);
        let_it_read().await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(recorded.opened_keys(), [oauth("a")]);
        assert!(
            recorded.keys().is_empty(),
            "it opens instead of notifying, with no notification left behind"
        );
    }

    #[tokio::test]
    async fn the_arrivals_closing_stops_the_notifications() {
        let (_statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(0);
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            RecordedRequests::default(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
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
