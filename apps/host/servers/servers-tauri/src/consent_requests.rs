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
//! [`ConsentNotificationCoalescer`]'s decision. The same coalescer counts the
//! servers with a request pending, which the app icon's badge shows, names the
//! request the ongoing notification Android shows while one is pending that
//! no server's own notification shows, and says which request each
//! notification posted names, which an action on it (Open, Deny) acts on. A
//! tap or an action takes its notification down: a server's own, whose
//! request the ongoing notification names from then on while it waits, or
//! the ongoing one, which posts again.

use std::collections::BTreeSet;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_page_browser::NativePageBrowserExt;
use tokio::sync::watch;
use wildflowerhealthio_servers::{
    ongoing_consent_notification_id_for_plugin, AnnouncedConsents, ConsentNotificationChanges,
    ConsentNotificationCoalescer, ConsentOpening, ConsentRequest, OngoingConsentNotification,
    ServerDetail, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::{
    ForegroundArrivals, TauriUnitRunner, UnitId, UnitStatuses,
};

use crate::launch_commands::ConsentToOpen;
use crate::notifications::{
    post_notification, withdraw_consent_notification, withdraw_ongoing_consent_notification,
    NotificationKind,
};
use crate::pending_consent_badge::{PendingConsentBadge, ShownBadgeCount};
use crate::server_units::NotificationTaps;
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
    /// Post the ongoing consent notification as `ongoing` says, where the
    /// platform shows one (Android), replacing the one posted.
    fn post_ongoing(&self, ongoing: &OngoingConsentNotification);
    /// Withdraw the ongoing consent notification.
    fn withdraw_ongoing(&self);
    /// Record the requests the notifications posted name, for an action on
    /// one to act on.
    fn record_announced(&self, announced_consents: AnnouncedConsents);
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
        post_notification(
            &self.app,
            &request.notification(),
            NotificationKind::ConsentRequest,
        );
    }

    fn withdraw(&self, domain: &str) {
        withdraw_consent_notification(&self.app, domain);
    }

    /// Only Android shows it: an iOS notification can't stay, and the
    /// desktop has the app's own window.
    fn post_ongoing(&self, ongoing: &OngoingConsentNotification) {
        if cfg!(target_os = "android") {
            post_notification(
                &self.app,
                &ongoing.notification(),
                NotificationKind::OngoingConsent,
            );
        }
    }

    fn withdraw_ongoing(&self) {
        withdraw_ongoing_consent_notification(&self.app);
    }

    fn record_announced(&self, announced_consents: AnnouncedConsents) {
        self.server_units
            .record_announced_consents(announced_consents);
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

/// Announce and open each consent request through `notifier`, with the
/// ongoing notification while one is pending, and show on `badge` how many
/// servers have one pending, every time `runner`'s statuses
/// change, the app arrives in or leaves the foreground, or a consent
/// notification is tapped, as [`ConsentNotificationCoalescer`] decides for
/// [`CONSENT_OPENING`].
pub(crate) async fn notify_consent_requests(
    notifier: AppConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    runner: TauriUnitRunner<ServerDetail>,
) {
    let statuses = runner.subscribe();
    let arrivals = runner.subscribe_foreground_arrivals();
    let taps = notifier.server_units.subscribe_notification_taps();
    notify_and_open_consent_requests(
        notifier,
        badge,
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
/// too, as none can open in the background. A tap, on a notification's text
/// or an action, also takes that notification down with the coalescer, as
/// the platform takes it down: a server's own leaves its request to the
/// ongoing notification, and the ongoing one posts again. When an arrival
/// and a change of the statuses are both ready, the arrival goes first: it
/// reads the statuses itself. After each, a server first seen has its
/// notification left from an earlier run of the app withdrawn
/// ([`LeftFromBefore`]), and the requests the notifications name are recorded
/// with `notifier`.
async fn notify_and_open_consent_requests(
    notifier: impl ConsentRequestNotifier,
    badge: impl PendingConsentBadge,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
    mut arrivals: watch::Receiver<ForegroundArrivals>,
    mut taps: watch::Receiver<NotificationTaps>,
    units_to_run: impl Fn() -> BTreeSet<UnitId>,
    opening: ConsentOpening,
) {
    let mut coalescer = ConsentNotificationCoalescer::new(opening);
    let mut shown_badge_count = ShownBadgeCount::default();
    let mut shown_ongoing = ShownOngoingNotification::default();
    let foreground = *arrivals.borrow_and_update();
    let mut seen_taps = SeenTaps(taps.borrow_and_update().count());
    let mut seen_arrivals = foreground.arrivals;
    if foreground.arrivals > 0 && foreground.in_foreground {
        arrive(
            &notifier,
            &mut coalescer,
            &mut statuses,
            (&mut taps, &mut seen_taps),
            &units_to_run,
        )
        .await;
    } else {
        let current = statuses.borrow_and_update().clone();
        apply(&notifier, &coalescer.record(&current));
    }
    let mut left_from_before = LeftFromBefore::default();
    loop {
        let announced_consents = coalescer.announced_consents();
        left_from_before.withdraw(&notifier, &statuses.borrow(), &announced_consents);
        notifier.record_announced(announced_consents);
        shown_badge_count.show_on(&badge, coalescer.pending_server_count());
        shown_ongoing.show_on(&notifier, coalescer.ongoing_notification());
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
                } else if arrived
                    && arrive(
                        &notifier,
                        &mut coalescer,
                        &mut statuses,
                        (&mut taps, &mut seen_taps),
                        &units_to_run,
                    )
                    .await
                {
                    shown_ongoing.forget();
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
                let ongoing_tapped = seen_taps.read(&taps.borrow_and_update(), &mut coalescer);
                coalescer.end_arrival_wait();
                if ongoing_tapped {
                    shown_ongoing.forget();
                }
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
/// arrival came to open a page of its own, or a consent notification was
/// tapped since the last tap read from `taps`, as the tap the arrival brings
/// may be before the arrival is read; either ends the arrival's wait instead.
/// The taps read, past `seen_taps`, take their notifications down first.
/// Then withdraw, announce and open through `notifier` as it says. Whether a
/// tap it read was on the ongoing notification.
async fn arrive(
    notifier: &impl ConsentRequestNotifier,
    coalescer: &mut ConsentNotificationCoalescer,
    statuses: &mut watch::Receiver<UnitStatuses<ServerDetail>>,
    (taps, seen_taps): (&mut watch::Receiver<NotificationTaps>, &mut SeenTaps),
    units_to_run: &impl Fn() -> BTreeSet<UnitId>,
) -> bool {
    let opens_its_own_page = notifier.take_arrival_opening_its_own_page().await;
    // A tap the select hasn't read yet: the arrival goes first there.
    let tapped = taps.has_changed().unwrap_or(false);
    let ongoing_tapped = tapped && seen_taps.read(&taps.borrow_and_update(), coalescer);
    let current = statuses.borrow_and_update().clone();
    let changes = if opens_its_own_page || tapped {
        coalescer.end_arrival_wait();
        coalescer.record(&current)
    } else {
        coalescer.came_to_foreground(&current, &units_to_run())
    };
    apply(notifier, &changes);
    ongoing_tapped
}

/// How many taps on consent notifications have been read.
#[derive(Debug)]
struct SeenTaps(u64);

impl SeenTaps {
    /// Read the taps `taps` holds past those seen: each takes its
    /// notification down in `coalescer`, as the platform took it down.
    /// Whether one was on the ongoing notification.
    fn read(
        &mut self,
        taps: &NotificationTaps,
        coalescer: &mut ConsentNotificationCoalescer,
    ) -> bool {
        let mut ongoing_tapped = false;
        for plugin_id in taps.tapped_since(self.0) {
            ongoing_tapped |= plugin_id == ongoing_consent_notification_id_for_plugin();
            coalescer.notification_taken_down(plugin_id);
        }
        self.0 = taps.count();
        ongoing_tapped
    }
}

/// The ongoing consent notification a [`ConsentRequestNotifier`] shows, so
/// it is posted again only when it changes. None known at the app's start, so
/// the first withdraws one left from an earlier run of the app; and none after
/// a tap on it, which takes it down on Android, so the next posts it again.
#[derive(Debug, Default)]
struct ShownOngoingNotification(Option<Option<OngoingConsentNotification>>);

impl ShownOngoingNotification {
    /// Post `ongoing` through `notifier`, or withdraw it once there is none,
    /// unless that is what shows already.
    fn show_on(
        &mut self,
        notifier: &impl ConsentRequestNotifier,
        ongoing: Option<OngoingConsentNotification>,
    ) {
        if self.0.as_ref() == Some(&ongoing) {
            return;
        }
        match &ongoing {
            Some(ongoing) => notifier.post_ongoing(ongoing),
            None => notifier.withdraw_ongoing(),
        }
        self.0 = Some(ongoing);
    }

    /// Forget what shows, as a tap took it down.
    fn forget(&mut self) {
        self.0 = None;
    }
}

/// The servers whose consent notification left from an earlier run of the
/// app was withdrawn: one no coalescer remembers, which on Android is kept
/// until it is withdrawn or tapped.
#[derive(Debug, Default)]
struct LeftFromBefore(BTreeSet<UnitId>);

impl LeftFromBefore {
    /// Withdraw through `notifier` the consent notification of each server
    /// first seen in `statuses` that `announced_consents` doesn't name. A
    /// request still waiting there notifies again once its server reports it.
    fn withdraw(
        &mut self,
        notifier: &impl ConsentRequestNotifier,
        statuses: &UnitStatuses<ServerDetail>,
        announced_consents: &AnnouncedConsents,
    ) {
        for unit_id in statuses.keys() {
            if !self.0.insert(unit_id.clone()) {
                continue;
            }
            let domain = unit_id.as_str();
            if !announced_consents
                .by_server
                .iter()
                .any(|request| request.domain == domain)
            {
                notifier.withdraw(domain);
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use wildflowerhealthio_authorization_server::NewestPendingConsent;

    use wildflowerhealthio_servers::{consent_notification_id_for_plugin, ConsentKey};
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;
    use crate::pending_consent_badge::tests::RecordedCounts;
    use crate::test_statuses::not_reporting;

    const RUTH: &str = "ruth.relay.example.com";

    /// The requests announced, the domains whose announcement was
    /// withdrawn, and the requests opened, each in order; how many times the
    /// waiting opens' waits were ended; whether the next arrival comes to
    /// open a page of its own, as one a tap brings on Android; each ongoing
    /// notification posted, or `None` for each withdrawal, in order; and the
    /// announced consents last recorded.
    #[derive(Clone, Default)]
    struct RecordedRequests(
        Arc<Mutex<Vec<ConsentRequest>>>,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<ConsentRequest>>>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        Arc<Mutex<Vec<Option<OngoingConsentNotification>>>>,
        Arc<Mutex<AnnouncedConsents>>,
    );

    impl ConsentRequestNotifier for RecordedRequests {
        fn notify(&self, request: &ConsentRequest) {
            self.0.lock().unwrap().push(request.clone());
        }

        fn withdraw(&self, domain: &str) {
            self.1.lock().unwrap().push(domain.to_owned());
        }

        fn post_ongoing(&self, ongoing: &OngoingConsentNotification) {
            self.5.lock().unwrap().push(Some(ongoing.clone()));
        }

        fn withdraw_ongoing(&self) {
            self.5.lock().unwrap().push(None);
        }

        fn record_announced(&self, announced_consents: AnnouncedConsents) {
            *self.6.lock().unwrap() = announced_consents;
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

        /// The key of the request each ongoing notification posted named,
        /// or `None` for each withdrawal, in order.
        fn ongoing_keys(&self) -> Vec<Option<ConsentKey>> {
            self.5
                .lock()
                .unwrap()
                .iter()
                .map(|ongoing| {
                    ongoing
                        .as_ref()
                        .map(|ongoing| ongoing.newest.pending_consent.key.clone())
                })
                .collect()
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
                decidable_in_requesting_browser: false,
            }),
            launch_minter: None,
            sign_in_code_minter: None,
            consent_watcher: None,
            consent_denier: None,
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
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
        taps_rx: watch::Receiver<NotificationTaps>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            RecordedCounts::default(),
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
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
        let (taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        // The tap opens its own consent, as `server_open_notified_consent`
        // does.
        taps_tx.send_modify(|taps| taps.record(consent_notification_id_for_plugin(RUTH)));
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
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
    async fn on_a_phone_an_arrival_read_with_a_tap_ready_opens_nothing() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(Some("a")));
        let (arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;
        assert_eq!(recorded.keys(), [oauth("a")]);

        // The tap's command runs before the notifier reads the arrival the
        // tap brings, as it may on iOS.
        taps_tx.send_modify(|taps| taps.record(consent_notification_id_for_plugin(RUTH)));
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
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
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            RecordedRequests::default(),
            RecordedCounts::default(),
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

    #[tokio::test]
    async fn the_badge_counts_a_server_while_a_request_is_pending_on_it_through_a_stopped_run() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let badge = RecordedCounts::default();
        let notifying = tokio::spawn(notify_and_open_consent_requests(
            recorded.clone(),
            badge.clone(),
            statuses_rx,
            arrivals_rx,
            taps_rx,
            ruth_to_run,
            ConsentOpening::AsNotified,
        ));
        let_it_read().await;

        // The first statuses clear a badge left from before, and withdraw
        // RUTH's notification left from before.
        assert_eq!(badge.shown(), [0]);
        assert_eq!(*recorded.1.lock().unwrap(), [RUTH]);

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(badge.shown(), [0, 1]);

        // A newer request is announced, and leaves the count as it is, so
        // the badge isn't set again.
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        assert_eq!(recorded.keys(), [oauth("a"), oauth("b")]);
        assert_eq!(badge.shown(), [0, 1]);

        // The run stops with "b" pending: its notification stays, and so
        // does the badge.
        send_and_let_it_read(&statuses_tx, ruth_not_reporting()).await;
        assert_eq!(*recorded.1.lock().unwrap(), [RUTH]);
        assert_eq!(badge.shown(), [0, 1]);

        // Started again, the run reports nothing pending: the notification
        // is withdrawn and the badge clears.
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(None)).await;
        drop(statuses_tx);
        notifying.await.unwrap();
        assert_eq!(*recorded.1.lock().unwrap(), [RUTH, RUTH]);
        assert_eq!(badge.shown(), [0, 1, 0]);
    }

    #[tokio::test]
    async fn the_ongoing_notification_names_a_request_once_its_own_notification_is_taken_down() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;
        // The first statuses withdraw one left from before.
        assert_eq!(recorded.ongoing_keys(), [None]);

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(recorded.keys(), [oauth("a")]);
        assert_eq!(
            recorded.ongoing_keys(),
            [None],
            "RUTH's own notification shows a"
        );

        // A tap on RUTH's own takes it down: the ongoing one names a.
        taps_tx.send_modify(|taps| taps.record(consent_notification_id_for_plugin(RUTH)));
        let_it_read().await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(
            recorded.ongoing_keys(),
            [None, Some(oauth("a"))],
            "shown once"
        );

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("b"))).await;
        assert_eq!(
            recorded.ongoing_keys(),
            [None, Some(oauth("a")), None],
            "RUTH's own shows the newer request"
        );

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        assert_eq!(
            recorded.ongoing_keys(),
            [None, Some(oauth("a")), None, Some(oauth("a"))],
            "b decided brings a back"
        );

        // A tap on the ongoing one, as on its Open, takes it down on
        // Android: it posts again.
        taps_tx.send_modify(|taps| taps.record(ongoing_consent_notification_id_for_plugin()));
        let_it_read().await;
        assert_eq!(recorded.ongoing_keys().len(), 5);

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(None)).await;
        drop(statuses_tx);
        notifying.await.unwrap();
        assert_eq!(
            recorded.ongoing_keys(),
            [
                None,
                Some(oauth("a")),
                None,
                Some(oauth("a")),
                Some(oauth("a")),
                None
            ],
            "cleared once nothing is pending"
        );
    }

    #[tokio::test]
    async fn a_server_s_notification_left_from_before_is_withdrawn_when_it_is_first_seen() {
        let (statuses_tx, statuses_rx) = watch::channel(UnitStatuses::default());
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        send_and_let_it_read(&statuses_tx, ruth_not_reporting()).await;
        assert_eq!(*recorded.1.lock().unwrap(), [RUTH]);
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        drop(statuses_tx);
        notifying.await.unwrap();

        assert_eq!(*recorded.1.lock().unwrap(), [RUTH], "once");
        assert_eq!(recorded.keys(), [oauth("a")]);
    }

    #[tokio::test]
    async fn the_requests_the_notifications_name_are_recorded_as_they_change() {
        let (statuses_tx, statuses_rx) = watch::channel(ruth_waiting_on(None));
        let (_arrivals_tx, arrivals_rx) = watch::channel(arrived(0));
        let (_taps_tx, taps_rx) = watch::channel(NotificationTaps::default());
        let recorded = RecordedRequests::default();
        let notifying = notify_on_a_phone(&recorded, statuses_rx, arrivals_rx, taps_rx);
        let_it_read().await;

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(Some("a"))).await;
        let announced = recorded.6.lock().unwrap().clone();
        assert_eq!(keys_of(&Mutex::new(announced.by_server)), [oauth("a")]);
        assert_eq!(announced.ongoing, None, "RUTH's own shows it");

        send_and_let_it_read(&statuses_tx, ruth_waiting_on(None)).await;
        drop(statuses_tx);
        notifying.await.unwrap();
        assert_eq!(*recorded.6.lock().unwrap(), AnnouncedConsents::default());
    }
}
